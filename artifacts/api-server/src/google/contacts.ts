import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  resourceName?: string;
}

export interface ContactSearchResult {
  contacts: Contact[];
  needsReauth: boolean;
  source: "live" | "curated" | "none";
}

// ── Table management ──────────────────────────────────────────────────────────
// google_contacts now holds ONLY explicitly-saved curated contacts (~20-30 people).
// It is NOT a bulk cache. The 650-person sync has been removed.

export async function ensureContactsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS google_contacts (
      id            SERIAL PRIMARY KEY,
      user_name     VARCHAR(100) NOT NULL,
      resource_name VARCHAR(255),
      display_name  VARCHAR(255) NOT NULL,
      email         VARCHAR(255),
      phone         VARCHAR(100),
      address       TEXT,
      notes         TEXT,
      saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS google_contacts_user_name_idx
    ON google_contacts(user_name)
  `);
  logger.info("[CONTACTS] google_contacts table ready");
}

// ── OAuth token helper ────────────────────────────────────────────────────────

interface GoogleAuthRow {
  user_name: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: Date | null;
  scope: string | null;
  email: string | null;
}

async function getAccessToken(): Promise<{ token: string; hasContactsScope: boolean; userName: string } | null> {
  const { rows } = await query<GoogleAuthRow>(
    `SELECT user_name, access_token, refresh_token, token_expiry, scope, email
     FROM google_auth
     ORDER BY
       CASE WHEN email NOT LIKE '%winston%' THEN 0 ELSE 1 END,
       updated_at DESC NULLS LAST
     LIMIT 5`
  );
  if (!rows.length) return null;

  for (const row of rows) {
    if (!row.access_token && !row.refresh_token) continue;

    const scope = row.scope ?? "";
    const hasContactsScope =
      scope.includes("contacts.readonly") ||
      scope.includes("contacts") ||
      scope.includes("directory.readonly");

    const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
    const isExpired = expiry > 0 && Date.now() > expiry - 60_000;

    if (isExpired && row.refresh_token) {
      try {
        const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID ?? "",
            client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
            refresh_token: row.refresh_token,
            grant_type: "refresh_token",
          }),
        });
        const refreshData = (await refreshResp.json()) as {
          access_token?: string;
          expires_in?: number;
          error?: string;
        };
        if (refreshData.access_token) {
          const newExpiry = new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000);
          await query(
            `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3`,
            [refreshData.access_token, newExpiry, row.user_name]
          );
          logger.info(`[CONTACTS] Token refreshed for ${row.email ?? row.user_name}`);
          return { token: refreshData.access_token, hasContactsScope, userName: row.user_name };
        }
        logger.warn(`[CONTACTS] Token refresh failed for ${row.user_name}: ${refreshData.error ?? "unknown"}`);
        continue;
      } catch (err) {
        logger.warn({ err }, `[CONTACTS] Token refresh exception for ${row.user_name}`);
        continue;
      }
    }

    if (row.access_token) {
      return { token: row.access_token, hasContactsScope, userName: row.user_name };
    }
  }

  logger.warn("[CONTACTS] No usable token found in any google_auth row");
  return null;
}

// ── Live search via Google People API ─────────────────────────────────────────
// Uses people:searchContacts — searches by name in real time.
// No local cache involved. Results come directly from Google.

async function searchContactsLive(searchName: string, token: string): Promise<Contact[]> {
  const url = new URL("https://people.googleapis.com/v1/people:searchContacts");
  url.searchParams.set("query", searchName);
  url.searchParams.set("readMask", "names,emailAddresses,phoneNumbers,addresses");
  url.searchParams.set("pageSize", "10");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    logger.warn(`[CONTACTS] people:searchContacts HTTP ${resp.status}: ${errBody.error?.message ?? resp.statusText}`);
    return [];
  }

  const data = await resp.json() as {
    results?: Array<{
      person?: {
        resourceName?: string;
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        phoneNumbers?: Array<{ value?: string }>;
        addresses?: Array<{ formattedValue?: string }>;
      };
    }>;
  };

  const contacts: Contact[] = [];
  for (const result of data.results ?? []) {
    const person = result.person;
    if (!person) continue;
    const displayName = person.names?.[0]?.displayName;
    if (!displayName) continue;
    const c: Contact = {
      name: displayName,
      resourceName: person.resourceName,
    };
    if (person.emailAddresses?.[0]?.value) c.email = person.emailAddresses[0].value;
    if (person.phoneNumbers?.[0]?.value) c.phone = person.phoneNumbers[0].value;
    if (person.addresses?.[0]?.formattedValue) c.address = person.addresses[0].formattedValue;
    contacts.push(c);
  }

  // ── Best-match name filter ─────────────────────────────────────────────────
  // The People API searches ALL contact fields (notes, tags, email, phone)
  // so results can include people who merely mention the search name in a note.
  // Strategy: score every result by how many search words appear in displayName,
  // then keep ONLY those that tied for the highest score.
  // If the top score is 0 (no result's name contains any search word) → return []
  // so the caller treats it as "not found" and Claude says so honestly.
  const searchWords = searchName.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (searchWords.length === 0) return contacts;

  const scored = contacts.map((c) => ({
    contact: c,
    score: searchWords.filter((w) => c.name.toLowerCase().includes(w)).length,
  }));

  const maxScore = Math.max(...scored.map((s) => s.score), 0);
  if (maxScore === 0) return []; // no name overlap at all — treat as no match

  // Return all contacts that tied for the best score.
  // If only one wins (typical for a full "First Last" search), caller gets one result.
  // If multiple tie (e.g. two people named "Susan"), caller shows "which one?" prompt.
  return scored.filter((s) => s.score === maxScore).map((s) => s.contact);
}

// ── Curated contact management ────────────────────────────────────────────────
// The google_contacts table holds ONLY contacts David has explicitly asked to save.
// Max ~30 people — his curated Winston contact list.

export async function saveCuratedContact(contact: Contact, userName: string): Promise<void> {
  await query(
    `INSERT INTO google_contacts (user_name, resource_name, display_name, email, phone, address)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [userName, contact.resourceName ?? null, contact.name, contact.email ?? null, contact.phone ?? null, contact.address ?? null]
  );
  logger.info(`[CONTACTS] Curated contact saved: ${contact.name} for ${userName}`);
}

export async function getCuratedContacts(userName: string): Promise<Contact[]> {
  type Row = { display_name: string; email: string | null; phone: string | null; address: string | null; resource_name: string | null };
  const { rows } = await query<Row>(
    `SELECT display_name, email, phone, address, resource_name
     FROM google_contacts WHERE user_name = $1 ORDER BY display_name`,
    [userName]
  );
  return rows.map((r) => ({
    name: r.display_name,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    address: r.address ?? undefined,
    resourceName: r.resource_name ?? undefined,
  }));
}

export async function removeCuratedContact(name: string, userName: string): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM google_contacts WHERE user_name = $1 AND LOWER(display_name) = LOWER($2) RETURNING id`,
    [userName, name]
  );
  return rows.length > 0;
}

// ── Public search API ─────────────────────────────────────────────────────────
// Always performs a live Google People API lookup — no local cache.

export async function searchContacts(searchQuery: string): Promise<ContactSearchResult> {
  try {
    console.log(`[CONTACTS] Live search for: "${searchQuery}"`);

    const tokenInfo = await getAccessToken();
    if (!tokenInfo) {
      logger.warn("[CONTACTS] searchContacts — no auth token available");
      return { contacts: [], needsReauth: false, source: "none" };
    }

    if (!tokenInfo.hasContactsScope) {
      logger.warn("[CONTACTS] contacts.readonly scope missing — David needs to reconnect Google");
      return { contacts: [], needsReauth: true, source: "none" };
    }

    const contacts = await searchContactsLive(searchQuery, tokenInfo.token);

    console.log(`[CONTACTS] Live search returned ${contacts.length} result(s) for "${searchQuery}":`);
    contacts.forEach((c, i) => {
      console.log(`[CONTACTS]   [${i + 1}] name="${c.name}" phone=${c.phone ?? "null"} email=${c.email ?? "null"}`);
    });

    return { contacts, needsReauth: false, source: contacts.length > 0 ? "live" : "none" };
  } catch (err: unknown) {
    logger.error({ err }, "[CONTACTS] searchContacts failed");
    return { contacts: [], needsReauth: false, source: "none" };
  }
}

// ── Onboarding family-contact suggestions ─────────────────────────────────────

export interface ContactSuggestion {
  name: string;
  relationship: string;
  email?: string;
  phone?: string;
  resourceName?: string;
  confidence: "high" | "medium";
  source: "relation" | "family_group" | "same_name";
}

const FAMILY_TYPES = new Set([
  "spouse", "partner", "domesticPartner", "wife", "husband",
  "child", "son", "daughter",
  "parent", "father", "mother",
  "sibling", "brother", "sister",
  "grandparent", "grandmother", "grandfather",
  "grandchild", "grandson", "granddaughter",
  "relative",
  "significantOther", "boyfriend", "girlfriend",
  "inLaw", "fatherInLaw", "motherInLaw", "sonInLaw", "daughterInLaw",
  "brotherInLaw", "sisterInLaw",
  "stepParent", "stepChild", "stepSibling",
  "halfSibling",
]);

const RELATION_LABELS: Record<string, string> = {
  spouse: "Spouse", partner: "Partner", domesticPartner: "Partner",
  wife: "Wife", husband: "Husband",
  child: "Child", son: "Son", daughter: "Daughter",
  parent: "Parent", father: "Father", mother: "Mother",
  sibling: "Sibling", brother: "Brother", sister: "Sister",
  grandparent: "Grandparent", grandmother: "Grandmother", grandfather: "Grandfather",
  grandchild: "Grandchild", grandson: "Grandson", granddaughter: "Granddaughter",
  relative: "Family", significantOther: "Partner", boyfriend: "Boyfriend", girlfriend: "Girlfriend",
  inLaw: "In-Law", fatherInLaw: "Father-in-Law", motherInLaw: "Mother-in-Law",
  sonInLaw: "Son-in-Law", daughterInLaw: "Daughter-in-Law",
  brotherInLaw: "Brother-in-Law", sisterInLaw: "Sister-in-Law",
  stepParent: "Step-Parent", stepChild: "Step-Child", stepSibling: "Step-Sibling",
  halfSibling: "Half-Sibling",
};

async function getAccessTokenForUser(
  userName: string
): Promise<{ token: string; hasContactsScope: boolean } | null> {
  const { rows } = await query<GoogleAuthRow>(
    `SELECT user_name, access_token, refresh_token, token_expiry, scope, email
     FROM google_auth WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (!row.access_token && !row.refresh_token) return null;

  const scope = row.scope ?? "";
  const hasContactsScope =
    scope.includes("contacts.readonly") ||
    scope.includes("contacts") ||
    scope.includes("directory.readonly");

  const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
  const isExpired = expiry > 0 && Date.now() > expiry - 60_000;

  if (isExpired && row.refresh_token) {
    try {
      const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID ?? "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
          refresh_token: row.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const refreshData = (await refreshResp.json()) as {
        access_token?: string; expires_in?: number; error?: string;
      };
      if (refreshData.access_token) {
        const newExpiry = new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000);
        await query(
          `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3`,
          [refreshData.access_token, newExpiry, userName]
        );
        return { token: refreshData.access_token, hasContactsScope };
      }
    } catch { return null; }
  }

  if (row.access_token) return { token: row.access_token, hasContactsScope };
  return null;
}

/**
 * Fetches family-member suggestions from Google Contacts for onboarding pre-population.
 * Applies three heuristics in priority order:
 *   1. Explicit relation labels (spouse, daughter, father, etc.)
 *   2. Membership in the built-in "family" contact group
 *   3. Same last name as the user
 */
export async function fetchFamilySuggestions(
  userName: string,
  userFullName?: string
): Promise<ContactSuggestion[]> {
  const auth = await getAccessTokenForUser(userName);
  if (!auth) {
    logger.info("[CONTACTS] No Google auth for user — skipping family suggestions");
    return [];
  }
  if (!auth.hasContactsScope) {
    logger.info("[CONTACTS] No contacts scope — skipping family suggestions");
    return [];
  }

  const url = new URL("https://people.googleapis.com/v1/people/me/connections");
  url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,relations,memberships");
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("sortOrder", "LAST_MODIFIED_DESCENDING");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    logger.warn(`[CONTACTS] connections.list HTTP ${resp.status}: ${errBody.error?.message ?? resp.statusText}`);
    return [];
  }

  type PeopleConnection = {
    resourceName?: string;
    names?: Array<{ displayName?: string; familyName?: string }>;
    emailAddresses?: Array<{ value?: string }>;
    phoneNumbers?: Array<{ value?: string }>;
    relations?: Array<{ type?: string; formattedType?: string }>;
    memberships?: Array<{ contactGroupMembership?: { contactGroupId?: string } }>;
  };

  const data = await resp.json() as { connections?: PeopleConnection[] };
  const connections = data.connections ?? [];
  logger.info(`[CONTACTS] connections.list — ${connections.length} contacts for family heuristics`);

  const userLastName = userFullName
    ? userFullName.trim().split(/\s+/).pop()?.toLowerCase()
    : undefined;

  const suggestions: ContactSuggestion[] = [];
  const seen = new Set<string>();

  for (const person of connections) {
    const displayName = person.names?.[0]?.displayName;
    if (!displayName || seen.has(displayName.toLowerCase())) continue;

    const email = person.emailAddresses?.[0]?.value;
    const phone = person.phoneNumbers?.[0]?.value;
    const personLastName = person.names?.[0]?.familyName?.toLowerCase();
    let suggestion: ContactSuggestion | null = null;

    // Heuristic 1: explicit family relation
    for (const rel of person.relations ?? []) {
      if (rel.type && FAMILY_TYPES.has(rel.type)) {
        const label = rel.formattedType ?? RELATION_LABELS[rel.type] ?? "Family";
        suggestion = {
          name: displayName,
          relationship: label,
          confidence: "high",
          source: "relation",
          resourceName: person.resourceName,
        };
        break;
      }
    }

    // Heuristic 2: built-in "family" contact group
    if (!suggestion) {
      const inFamilyGroup = (person.memberships ?? []).some(
        (m) => m.contactGroupMembership?.contactGroupId === "family"
      );
      if (inFamilyGroup) {
        suggestion = {
          name: displayName,
          relationship: "Family",
          confidence: "high",
          source: "family_group",
          resourceName: person.resourceName,
        };
      }
    }

    // Heuristic 3: same last name as user
    if (!suggestion && userLastName && personLastName === userLastName) {
      suggestion = {
        name: displayName,
        relationship: "Family",
        confidence: "medium",
        source: "same_name",
        resourceName: person.resourceName,
      };
    }

    if (suggestion) {
      if (email) suggestion.email = email;
      if (phone) suggestion.phone = phone;
      suggestions.push(suggestion);
      seen.add(displayName.toLowerCase());
    }
  }

  // High-confidence first, then prefer contacts with a phone number
  suggestions.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
    return (b.phone ? 1 : 0) - (a.phone ? 1 : 0);
  });

  const top = suggestions.slice(0, 8);
  logger.info(`[CONTACTS] Family suggestions: ${top.length} returned for ${userName}`);
  return top;
}

// ── Format for Claude prompt ──────────────────────────────────────────────────

export function formatContactsForPrompt(result: ContactSearchResult, searchName: string): string {
  if (result.needsReauth) {
    return (
      `\n\n[Google Contacts — Reconnection Required]\n` +
      `David's Google account does not currently include contacts permission. ` +
      `Tell David exactly this: "To look up contacts I'll need you to quickly reconnect your Google account — ` +
      `just go to Settings and tap Reconnect Google. It only takes a minute and you won't lose anything." ` +
      `Do NOT say you "don't have access" — frame it as a quick one-time reconnect that fixes it permanently.`
    );
  }

  if (result.contacts.length === 0) {
    return (
      `\n\n[VERIFIED — Google Contacts Live Search: "${searchName}" — NO RESULTS]\n` +
      `The Google Contacts API was searched live and returned ZERO results for "${searchName}". ` +
      `There is NO contact with this name in David's Google Contacts. This is VERIFIED. ` +
      `You MUST NOT generate, invent, guess, or infer any phone number, email, or contact detail. ` +
      `Say: "I searched your Google Contacts and couldn't find anyone named ${searchName}. Want me to add them manually?"`
    );
  }

  const lines = result.contacts.map((c) => {
    const details: string[] = [];
    if (c.email) details.push(`email: ${c.email}`);
    if (c.phone) details.push(`phone: ${c.phone}`);
    if (c.address) details.push(`address: ${c.address}`);
    return `• ${c.name}${details.length ? " — " + details.join(" | ") : ""}`;
  });

  if (result.contacts.length === 1) {
    const c = result.contacts[0];
    return (
      `\n\n[VERIFIED — Google Contacts Live Search: "${searchName}"]\n` +
      `${lines[0]}\n` +
      `Source: Google People API (live lookup — not cached). State the contact's name, phone, and email exactly as shown. ` +
      `Do not add, modify, or infer any details not present here.\n` +
      `After sharing this info, ask David: "Want me to remember ${c.name} in your Winston contacts for next time?"`
    );
  }

  return (
    `\n\n[VERIFIED — Google Contacts Live Search — Multiple Matches for "${searchName}"]\n` +
    `${lines.join("\n")}\n` +
    `Source: Google People API (live lookup). Ask David which one he means — ` +
    `"I found a few people named ${searchName.split(" ")[0]} — which one did you mean?" ` +
    `Do NOT share phone or email until David confirms which person. ` +
    `Once he confirms, ask if he wants to save them to his Winston contacts.`
  );
}

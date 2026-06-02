import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  organization?: string;
  website?: string;
  birthday?: string;
  notes?: string;
  resourceName?: string;
}

export interface ContactSearchResult {
  contacts: Contact[];
  needsReauth: boolean;
  source: "live" | "curated" | "connections" | "none";
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
  // Idempotent column additions — safe to run on every startup
  await query(`ALTER TABLE google_contacts ADD COLUMN IF NOT EXISTS birthday TEXT`).catch(() => {});
  await query(`ALTER TABLE google_contacts ADD COLUMN IF NOT EXISTS anniversary TEXT`).catch(() => {});
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
            `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3 RETURNING user_name`,
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

// ── Shared person-field type used by both search paths ────────────────────────
type PersonResource = {
  resourceName?: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  addresses?: Array<{ formattedValue?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  urls?: Array<{ value?: string }>;
  birthdays?: Array<{
    date?: { year?: number; month?: number; day?: number };
    text?: string;
  }>;
  biographies?: Array<{ value?: string }>;
};

/** Convert a raw People API person object into a Contact, or null if unusable. */
function personResourceToContact(person: PersonResource): { contact: Contact; orgName: string } | null {
  const displayName = person.names?.[0]?.displayName;
  const org = person.organizations?.[0];
  const rawOrgName = org?.name ?? "";
  const effectiveName = displayName ?? rawOrgName;
  if (!effectiveName) return null;

  const c: Contact = { name: effectiveName, resourceName: person.resourceName };

  if (person.emailAddresses?.[0]?.value) c.email = person.emailAddresses[0].value;
  if (person.phoneNumbers?.[0]?.value)   c.phone = person.phoneNumbers[0].value;
  if (person.addresses?.[0]?.formattedValue) c.address = person.addresses[0].formattedValue;
  if (rawOrgName) c.organization = org?.title ? `${rawOrgName} — ${org.title}` : rawOrgName;
  if (person.urls?.[0]?.value) c.website = person.urls[0].value;

  const bday = person.birthdays?.[0];
  if (bday) {
    if (bday.text) {
      c.birthday = bday.text;
    } else if (bday.date) {
      const { year, month, day } = bday.date;
      const parts: string[] = [];
      if (month) parts.push(String(month).padStart(2, "0"));
      if (day)   parts.push(String(day).padStart(2, "0"));
      if (year)  parts.unshift(String(year));
      c.birthday = parts.join("-");
    }
  }

  if (person.biographies?.[0]?.value) c.notes = person.biographies[0].value;

  return { contact: c, orgName: rawOrgName };
}

/** Score and filter a list of contacts against search words across name/org/phone/email. */
function scoreAndFilter(
  entries: Array<{ contact: Contact; orgName: string }>,
  searchWords: string[]
): Contact[] {
  if (searchWords.length === 0) return entries.map((e) => e.contact);

  const scored = entries.map(({ contact: c, orgName }) => {
    const fields = [
      c.name.toLowerCase(),
      orgName.toLowerCase(),
      (c.phone ?? "").toLowerCase(),
      (c.email ?? "").toLowerCase(),
    ];
    const score = searchWords.filter((w) => fields.some((f) => f.includes(w))).length;
    return { contact: c, score };
  });

  const maxScore = Math.max(...scored.map((s) => s.score), 0);
  if (maxScore === 0) return [];
  return scored.filter((s) => s.score === maxScore).map((s) => s.contact);
}

// ── Live search via Google People API ─────────────────────────────────────────
// Uses people:searchContacts — searches by name in real time.
// NOTE: This API does NOT index organization-only contacts (contacts with no
// personal name). Falls back to searchConnectionsLocally for those cases.

async function searchContactsLive(searchName: string, token: string): Promise<Contact[]> {
  const url = new URL("https://people.googleapis.com/v1/people:searchContacts");
  url.searchParams.set("query", searchName);
  url.searchParams.set(
    "readMask",
    "names,emailAddresses,phoneNumbers,addresses,organizations,urls,birthdays,biographies"
  );
  url.searchParams.set("pageSize", "30"); // 30 is Google's max for searchContacts

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    logger.warn(`[CONTACTS] people:searchContacts HTTP ${resp.status}: ${errBody.error?.message ?? resp.statusText}`);
    return [];
  }

  const data = await resp.json() as { results?: Array<{ person?: PersonResource }> };

  logger.info(`[CONTACTS] searchContacts raw results: ${data.results?.length ?? 0} for "${searchName}"`);

  const entries = (data.results ?? [])
    .map((r) => r.person ? personResourceToContact(r.person) : null)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const searchWords = searchName.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  return scoreAndFilter(entries, searchWords);
}

// ── Fallback: scan all connections locally ─────────────────────────────────────
// Used when searchContactsLive returns nothing — covers org-only contacts that
// Google's search index doesn't surface (no personal name, only organization).
// Fetches up to 2 pages of 1000 contacts each (2000 total) and filters locally.

async function searchConnectionsLocally(searchName: string, token: string): Promise<Contact[]> {
  const searchWords = searchName.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (searchWords.length === 0) return [];

  const persons: PersonResource[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL("https://people.googleapis.com/v1/people/me/connections");
    url.searchParams.set(
      "personFields",
      "names,emailAddresses,phoneNumbers,addresses,organizations,urls,birthdays,biographies"
    );
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      logger.warn(`[CONTACTS] connections.list HTTP ${resp.status} during local search`);
      break;
    }

    const data = await resp.json() as {
      connections?: PersonResource[];
      nextPageToken?: string;
      totalPeople?: number;
    };

    if (data.connections) persons.push(...data.connections);
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < 2); // cap at 2000 contacts

  logger.info(`[CONTACTS] connections.list loaded ${persons.length} contacts for local org search`);

  const entries = persons
    .map((p) => personResourceToContact(p))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return scoreAndFilter(entries, searchWords);
}

// ── Curated contact management ────────────────────────────────────────────────
// The google_contacts table holds ONLY contacts David has explicitly asked to save.
// Max ~30 people — his curated Winston contact list.

export async function saveCuratedContact(contact: Contact, userName: string): Promise<void> {
  await query(
    `INSERT INTO google_contacts (user_name, resource_name, display_name, email, phone, address)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
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

/**
 * Set or update a birthday or anniversary on an existing curated contact.
 * dateMMDD should be in "MM-DD" format (e.g. "06-15" for June 15).
 * Returns true if a matching contact was found and updated.
 */
export async function updateContactDate(
  userName: string,
  contactName: string,
  field: "birthday" | "anniversary",
  dateMMDD: string
): Promise<boolean> {
  const col = field === "birthday" ? "birthday" : "anniversary";
  const { rows } = await query(
    `UPDATE google_contacts
        SET ${col} = $1
      WHERE user_name = $2
        AND LOWER(display_name) LIKE LOWER($3)
      RETURNING id`,
    [dateMMDD, userName, `%${contactName.trim()}%`]
  );
  if (rows.length > 0) {
    logger.info({ userName, contactName, field, dateMMDD }, "[CONTACTS] Date updated on contact");
  }
  return rows.length > 0;
}

// ── Public search API ─────────────────────────────────────────────────────────
// Always performs a live Google People API lookup — no local cache.

export async function searchContacts(searchQuery: string, userName?: string): Promise<ContactSearchResult> {
  try {
    console.log(`[CONTACTS] Live search for: "${searchQuery}"${userName ? ` (user: ${userName})` : ""}`);

    const tokenInfo = userName
      ? await getAccessTokenForUser(userName)
      : await getAccessToken();
    if (!tokenInfo) {
      logger.warn(`[CONTACTS] searchContacts — no auth token available${userName ? ` for ${userName}` : ""}`);
      return { contacts: [], needsReauth: false, source: "none" };
    }

    if (!tokenInfo.hasContactsScope) {
      logger.warn(`[CONTACTS] contacts.readonly scope missing${userName ? ` for ${userName}` : ""} — needs to reconnect Google`);
      return { contacts: [], needsReauth: true, source: "none" };
    }

    let contacts = await searchContactsLive(searchQuery, tokenInfo.token);
    let source: "live" | "connections" | "none" = contacts.length > 0 ? "live" : "none";

    // searchContacts doesn't index org-only contacts (no personal name field).
    // Fall back to a local scan of all connections when the primary search misses.
    if (contacts.length === 0) {
      logger.info(`[CONTACTS] searchContacts returned 0 — trying local connections scan for "${searchQuery}"`);
      contacts = await searchConnectionsLocally(searchQuery, tokenInfo.token);
      source = contacts.length > 0 ? "connections" : "none";
    }

    logger.info(
      { count: contacts.length, source },
      `[CONTACTS] search complete for "${searchQuery}"`
    );

    return { contacts, needsReauth: false, source };
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
          `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3 RETURNING user_name`,
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

export function formatContactsForPrompt(result: ContactSearchResult, searchName: string, companionName?: string): string {
  if (result.needsReauth) {
    return (
      `\n\n[Google Contacts — Reconnection Required]\n` +
      `The user's Google account does not currently include contacts permission. ` +
      `Tell them exactly this: "To look up contacts I'll need you to quickly reconnect your Google account — ` +
      `just go to Settings and tap Reconnect Google. It only takes a minute and you won't lose anything." ` +
      `Do NOT say you "don't have access" — frame it as a quick one-time reconnect that fixes it permanently.`
    );
  }

  if (result.contacts.length === 0) {
    return (
      `\n\n[VERIFIED — Google Contacts Live Search: "${searchName}" — NO RESULTS]\n` +
      `The Google Contacts API was searched live and returned ZERO results for "${searchName}". ` +
      `There is NO contact with this name in the user's Google Contacts. This is VERIFIED. ` +
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
      `After sharing this info, ask: "Want me to remember ${c.name} in your ${companionName ?? "Winston"} contacts for next time?"`
    );
  }

  return (
    `\n\n[VERIFIED — Google Contacts Live Search — Multiple Matches for "${searchName}"]\n` +
    `${lines.join("\n")}\n` +
    `Source: Google People API (live lookup). Ask which one they mean — ` +
    `"I found a few people named ${searchName.split(" ")[0]} — which one did you mean?" ` +
    `Do NOT share phone or email until the user confirms which person. ` +
    `Once they confirm, ask if they want to save them to their ${companionName ?? "Winston"} contacts.`
  );
}

// ── Google Contacts write access ──────────────────────────────────────────────
// Requires the contacts (write) scope: https://www.googleapis.com/auth/contacts
// Users who authenticated before this scope was added will need to reconnect Google.

export interface NewContact {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface ContactWriteResult {
  ok: boolean;
  resourceName?: string;
  error?: string;
  needsReauth?: boolean;
}

/** Create a new contact in the user's Google Contacts. */
export async function createGoogleContact(
  contact: NewContact,
  userName: string,
): Promise<ContactWriteResult> {
  const tokenInfo = await getAccessTokenForUser(userName);
  if (!tokenInfo) return { ok: false, error: "Google not connected" };

  const scope = tokenInfo as unknown as { token: string; hasContactsScope: boolean; userName: string };
  const { rows: authRows } = await query<{ scope: string | null }>(
    `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  const hasWriteScope = authRows[0]?.scope
    ?.split(" ")
    .some((s) => s === "https://www.googleapis.com/auth/contacts") ?? false;

  if (!hasWriteScope) {
    return { ok: false, needsReauth: true, error: "contacts write scope required — please reconnect Google" };
  }

  const body: Record<string, unknown> = {
    names: [{ givenName: contact.name.split(" ")[0], familyName: contact.name.split(" ").slice(1).join(" ") }],
  };
  if (contact.phone) body.phoneNumbers = [{ value: contact.phone }];
  if (contact.email) body.emailAddresses = [{ value: contact.email }];
  if (contact.address) body.addresses = [{ formattedValue: contact.address }];
  if (contact.notes) body.biographies = [{ value: contact.notes, contentType: "TEXT_PLAIN" }];

  try {
    const resp = await fetch("https://people.googleapis.com/v1/people:createContact", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: { message?: string } };
      const msg = err.error?.message ?? resp.statusText;
      logger.warn({ userName, status: resp.status, msg }, "[CONTACTS] createGoogleContact failed");
      if (resp.status === 403) return { ok: false, needsReauth: true, error: msg };
      return { ok: false, error: msg };
    }

    const data = await resp.json() as { resourceName?: string };
    logger.info({ userName, resourceName: data.resourceName }, "[CONTACTS] Google contact created");

    // Also save to local curated contacts
    await saveCuratedContact({ name: contact.name, phone: contact.phone, email: contact.email, address: contact.address, resourceName: data.resourceName }, userName).catch(() => {});

    return { ok: true, resourceName: data.resourceName };
  } catch (err) {
    logger.error({ err, userName }, "[CONTACTS] createGoogleContact exception");
    return { ok: false, error: String(err) };
  }
}

/** Update a single field on an existing Google contact by resourceName or display name. */
export async function updateGoogleContact(
  userName: string,
  resourceName: string,
  updates: { phone?: string; email?: string; address?: string; notes?: string },
): Promise<ContactWriteResult> {
  const tokenInfo = await getAccessTokenForUser(userName);
  if (!tokenInfo) return { ok: false, error: "Google not connected" };

  const { rows: authRows } = await query<{ scope: string | null }>(
    `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  const hasWriteScope = authRows[0]?.scope
    ?.split(" ")
    .some((s) => s === "https://www.googleapis.com/auth/contacts") ?? false;

  if (!hasWriteScope) {
    return { ok: false, needsReauth: true, error: "contacts write scope required — please reconnect Google" };
  }

  // Build update mask and body
  const updatePersonFields: string[] = [];
  const body: Record<string, unknown> = { etag: "*" };

  if (updates.phone !== undefined) {
    updatePersonFields.push("phoneNumbers");
    body.phoneNumbers = updates.phone ? [{ value: updates.phone }] : [];
  }
  if (updates.email !== undefined) {
    updatePersonFields.push("emailAddresses");
    body.emailAddresses = updates.email ? [{ value: updates.email }] : [];
  }
  if (updates.address !== undefined) {
    updatePersonFields.push("addresses");
    body.addresses = updates.address ? [{ formattedValue: updates.address }] : [];
  }
  if (updates.notes !== undefined) {
    updatePersonFields.push("biographies");
    body.biographies = updates.notes ? [{ value: updates.notes, contentType: "TEXT_PLAIN" }] : [];
  }

  if (updatePersonFields.length === 0) return { ok: false, error: "no fields to update" };

  const url = `https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=${updatePersonFields.join(",")}`;

  try {
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: { message?: string } };
      const msg = err.error?.message ?? resp.statusText;
      logger.warn({ userName, resourceName, status: resp.status, msg }, "[CONTACTS] updateGoogleContact failed");
      if (resp.status === 403) return { ok: false, needsReauth: true, error: msg };
      return { ok: false, error: msg };
    }

    logger.info({ userName, resourceName, fields: updatePersonFields }, "[CONTACTS] Google contact updated");

    // Update local curated contacts table too
    const updateFields: string[] = [];
    const updateVals: unknown[] = [userName, resourceName];
    if (updates.phone !== undefined) { updateFields.push(`phone = $${updateVals.length + 1}`); updateVals.push(updates.phone || null); }
    if (updates.email !== undefined) { updateFields.push(`email = $${updateVals.length + 1}`); updateVals.push(updates.email || null); }
    if (updates.address !== undefined) { updateFields.push(`address = $${updateVals.length + 1}`); updateVals.push(updates.address || null); }
    if (updateFields.length > 0) {
      await query(
        `UPDATE google_contacts SET ${updateFields.join(", ")} WHERE user_name = $1 AND resource_name = $2 RETURNING id`,
        updateVals
      ).catch(() => {});
    }

    return { ok: true, resourceName };
  } catch (err) {
    logger.error({ err, userName }, "[CONTACTS] updateGoogleContact exception");
    return { ok: false, error: String(err) };
  }
}

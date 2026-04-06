import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface ContactSearchResult {
  contacts: Contact[];
  needsReauth: boolean;
}

// ── Table management ──────────────────────────────────────────────────────────

export async function ensureContactsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS google_contacts (
      id           SERIAL PRIMARY KEY,
      user_name    VARCHAR(100) NOT NULL,
      resource_name VARCHAR(255),
      display_name  VARCHAR(255) NOT NULL,
      email        VARCHAR(255),
      phone        VARCHAR(100),
      address      TEXT,
      cached_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS google_contacts_user_name_idx
    ON google_contacts(user_name)
  `);
  logger.info("[CONTACTS] google_contacts table ready");
}

// ── Token helper ──────────────────────────────────────────────────────────────

interface GoogleAuthRow {
  user_name: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: Date | null;
  scope: string | null;
  email: string | null;
}

// Finds the best available Google OAuth token for contacts access.
// Prefers personal accounts (non-winston emails) over app service accounts,
// since contacts typically live in the user's personal Google account.
async function getAccessToken(): Promise<{ token: string; hasContactsScope: boolean; userName: string } | null> {
  const { rows } = await query<GoogleAuthRow>(
    `SELECT user_name, access_token, refresh_token, token_expiry, scope, email
     FROM google_auth
     ORDER BY
       -- Prefer personal (non-winston) accounts which have real contacts
       CASE WHEN email NOT LIKE '%winston%' THEN 0 ELSE 1 END,
       -- Then prefer most recently updated
       updated_at DESC NULLS LAST
     LIMIT 5`
  );
  if (!rows.length) return null;

  // Try each row in preference order; return the first one with a usable token
  for (const row of rows) {
    if (!row.access_token && !row.refresh_token) continue;

    const scope = row.scope ?? "";
    const hasContactsScope =
      scope.includes("contacts.readonly") ||
      scope.includes("contacts") ||
      scope.includes("directory.readonly");

    // Check if token is expired (with 60s buffer)
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
        continue; // Try next account
      } catch (err) {
        logger.warn({ err }, `[CONTACTS] Token refresh exception for ${row.user_name}`);
        continue;
      }
    }

    if (row.access_token) {
      logger.info(`[CONTACTS] Using token for ${row.email ?? row.user_name} (expired=${isExpired})`);
      return { token: row.access_token, hasContactsScope, userName: row.user_name };
    }
  }

  logger.warn("[CONTACTS] No usable token found in any google_auth row");
  return null;
}

// ── Fetch contacts from Google and cache them ─────────────────────────────────

export async function syncContactsToCache(userName = "David"): Promise<number> {
  console.log("[CONTACTS] fetching Google contacts");

  const tokenInfo = await getAccessToken();
  if (!tokenInfo) {
    logger.warn("[CONTACTS] syncContactsToCache — no auth token available");
    return 0;
  }
  if (!tokenInfo.hasContactsScope) {
    logger.warn("[CONTACTS] syncContactsToCache — contacts.readonly scope not in token — David needs to reconnect Google");
    return -1; // signal: needs reauth
  }

  const allContacts: Contact[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://people.googleapis.com/v1/people/me/connections");
    url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,addresses");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokenInfo.token}` },
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errBody as { error?: { message?: string } }).error?.message ?? resp.statusText;
      if (resp.status === 401 || resp.status === 403) {
        logger.warn(`[CONTACTS] API returned ${resp.status} — scope missing or token invalid. Message: ${errMsg}`);
        return -1;
      }
      logger.error(`[CONTACTS] people.me.connections HTTP ${resp.status}: ${errMsg}`);
      return 0;
    }

    const data = await resp.json() as {
      connections?: Array<{
        resourceName?: string;
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        phoneNumbers?: Array<{ value?: string }>;
        addresses?: Array<{ formattedValue?: string }>;
      }>;
      nextPageToken?: string;
      totalItems?: number;
    };

    const connections = data.connections ?? [];
    console.log(`[CONTACTS] returning result from Google API — page has ${connections.length} records, totalItems=${data.totalItems ?? "unknown"}, raw sample: ${JSON.stringify(connections.slice(0, 2))}`);

    for (const person of connections) {
      const displayName = person.names?.[0]?.displayName;
      if (!displayName) continue;
      // Only add contacts with a valid display name directly from the API — never inferred
      const contact: Contact = { name: displayName };
      if (person.emailAddresses?.[0]?.value) contact.email = person.emailAddresses[0].value;
      if (person.phoneNumbers?.[0]?.value) contact.phone = person.phoneNumbers[0].value;
      if (person.addresses?.[0]?.formattedValue) contact.address = person.addresses[0].formattedValue;
      allContacts.push(contact);
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`[CONTACTS] found ${allContacts.length} connections total from Google People API`);

  if (allContacts.length === 0) return 0;

  // Replace cache: delete old entries then insert fresh batch
  await query(`DELETE FROM google_contacts WHERE user_name = $1 RETURNING id`, [userName]);

  for (const c of allContacts) {
    await query(
      `INSERT INTO google_contacts (user_name, display_name, email, phone, address, cached_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [userName, c.name, c.email ?? null, c.phone ?? null, c.address ?? null]
    );
  }

  logger.info({ count: allContacts.length }, "[CONTACTS] Cache synced to google_contacts table");
  return allContacts.length;
}

// ── Search from cache ─────────────────────────────────────────────────────────

async function isCacheStale(userName = "David"): Promise<boolean> {
  const { rows } = await query<{ cached_at: Date; count: string }>(
    `SELECT MAX(cached_at) as cached_at, COUNT(*) as count FROM google_contacts WHERE user_name = $1`,
    [userName]
  );
  if (!rows.length || rows[0].count === "0") return true; // empty = stale
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  return Date.now() - new Date(rows[0].cached_at).getTime() > maxAge;
}

async function searchCachedContacts(searchName: string, userName = "David"): Promise<Contact[]> {
  const nameLower = searchName.toLowerCase().trim();

  type ContactRow = { display_name: string; email: string | null; phone: string | null; address: string | null };

  // 1. Exact full-name match (case-insensitive)
  const { rows: exactRows } = await query<ContactRow>(
    `SELECT display_name, email, phone, address
     FROM google_contacts
     WHERE user_name = $1 AND LOWER(display_name) = $2
     ORDER BY display_name`,
    [userName, nameLower]
  );
  if (exactRows.length === 1) {
    const r = exactRows[0];
    return [{ name: r.display_name, email: r.email ?? undefined, phone: r.phone ?? undefined, address: r.address ?? undefined }];
  }

  // 2. All search words appear as whole words in the display name
  //    e.g. "Eric Blackstone" only matches contacts where BOTH words appear
  const words = nameLower.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const wordConditions = words.map((w, i) => `LOWER(display_name) LIKE $${i + 3}`).join(" AND ");
    const wordParams = words.map((w) => `%${w}%`);
    const { rows: wordRows } = await query<ContactRow>(
      `SELECT display_name, email, phone, address
       FROM google_contacts
       WHERE user_name = $1 AND LOWER(display_name) != $2 AND ${wordConditions}
       ORDER BY display_name
       LIMIT 10`,
      [userName, nameLower, ...wordParams]
    );
    const combined = [...exactRows, ...wordRows];
    if (combined.length > 0) {
      return combined.map((r) => ({
        name: r.display_name,
        email: r.email ?? undefined,
        phone: r.phone ?? undefined,
        address: r.address ?? undefined,
      }));
    }
  }

  // 3. Fallback: substring match on full display name (catches partial queries)
  const fallbackTerm = `%${nameLower}%`;
  const { rows: fallbackRows } = await query<ContactRow>(
    `SELECT display_name, email, phone, address
     FROM google_contacts
     WHERE user_name = $1 AND LOWER(display_name) LIKE $2
     ORDER BY display_name
     LIMIT 10`,
    [userName, fallbackTerm]
  );
  return fallbackRows.map((r) => ({
    name: r.display_name,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    address: r.address ?? undefined,
  }));
}

// ── Public search API ─────────────────────────────────────────────────────────

export async function searchContacts(searchQuery: string, forceRefresh = true): Promise<ContactSearchResult> {
  try {
    console.log(`[CONTACTS] searching for name: "${searchQuery}" (forceRefresh=${forceRefresh})`);

    // Always do a live API sync before searching — never serve stale or cached contact data
    // forceRefresh=true (default) means we always hit the Google People API fresh
    if (forceRefresh || await isCacheStale()) {
      console.log("[CONTACTS] syncing from Google People API (live) before search");
      const synced = await syncContactsToCache();
      if (synced === -1) {
        // needs reauth
        return { contacts: [], needsReauth: true };
      }
      console.log(`[CONTACTS] live sync complete — ${synced} contacts in cache`);
    }

    // Search the local cache
    const contacts = await searchCachedContacts(searchQuery);

    if (contacts.length > 0) {
      // Log each returned contact with ALL fields for verification — these came from the DB cache
      // which was populated exclusively from the Google People API. Never inferred.
      console.log(`[CONTACTS] returning ${contacts.length} result(s) from Google API cache for "${searchQuery}":`);
      contacts.forEach((c, i) => {
        console.log(`[CONTACTS]   [${i + 1}] name="${c.name}" phone=${c.phone ?? "null"} email=${c.email ?? "null"} address=${c.address ?? "null"}`);
      });
    } else {
      console.log(`[CONTACTS] no results found for "${searchQuery}" — cache size checked, 0 matches`);
    }

    return { contacts, needsReauth: false };
  } catch (err: unknown) {
    logger.error({ err }, "[CONTACTS] searchContacts failed");
    return { contacts: [], needsReauth: false };
  }
}

// ── Format for Claude prompt ──────────────────────────────────────────────────

export function formatContactsForPrompt(result: ContactSearchResult, query: string): string {
  if (result.needsReauth) {
    return (
      `\n\n[Google Contacts — Reconnection Required]\n` +
      `David's Google account does not currently include contacts permission. ` +
      `This is because the contacts scope was added after his last sign-in. ` +
      `Tell David exactly this: "To look up contacts I'll need you to quickly reconnect your Google account — ` +
      `just go to Settings and tap Reconnect Google. It only takes a minute and you won't lose anything." ` +
      `Do NOT say you "don't have access" — frame it as a quick one-time reconnect that fixes it permanently.`
    );
  }

  if (result.contacts.length === 0) {
    return (
      `\n\n[Google Contacts — Search: "${query}" — NO RESULTS]\n` +
      `CRITICAL: The Google Contacts API was searched and returned ZERO results for "${query}". ` +
      `There is NO contact with this name in David's Google Contacts. ` +
      `You MUST NOT generate, invent, guess, or infer any phone number, email address, or other contact detail. ` +
      `DO NOT present any contact information. ` +
      `Say EXACTLY this, with no additions: "I searched your Google Contacts and couldn't find anyone named ${query}. Do you want to add them manually?" ` +
      `Any phone number or email you might produce would be fabricated and wrong — DO NOT do it.`
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
    return (
      `\n\n[Google Contacts — Search: "${query}"]\n` +
      `${lines[0]}\n` +
      `Read the contact's name, phone, and email naturally. ` +
      `Ask David to confirm before saving anything to his Winston profile.`
    );
  }

  // Multiple matches — ask David which one he means
  return (
    `\n\n[Google Contacts — Multiple Matches for "${query}"]\n` +
    `${lines.join("\n")}\n` +
    `I found ${result.contacts.length} people matching "${query}". ` +
    `Ask David which one he means — list their names and ask him to pick: ` +
    `"I found a few people named ${query.split(" ")[0]} — which one did you mean?" ` +
    `Then list each name concisely. Do NOT share phone or email until David confirms which person.`
  );
}

// ── Daily refresh scheduler ───────────────────────────────────────────────────

export function startContactsSyncScheduler(): void {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // Initial sync on startup (non-blocking, after 10 seconds to let server settle)
  setTimeout(() => {
    syncContactsToCache().then((count) => {
      if (count > 0) logger.info({ count }, "[CONTACTS] Initial contacts cache sync complete");
      else if (count === -1) logger.warn("[CONTACTS] Initial sync skipped — contacts.readonly scope not in token");
      else logger.info("[CONTACTS] Initial sync: 0 contacts (empty Google Contacts or token issue)");
    }).catch((err) => logger.warn({ err }, "[CONTACTS] Initial sync failed"));
  }, 10_000);

  // Daily refresh
  setInterval(() => {
    syncContactsToCache().then((count) => {
      if (count > 0) logger.info({ count }, "[CONTACTS] Daily contacts cache refresh complete");
    }).catch((err) => logger.warn({ err }, "[CONTACTS] Daily sync failed"));
  }, TWENTY_FOUR_HOURS);

  logger.info("[CONTACTS] Contacts sync scheduler started (daily refresh + immediate sync on startup)");
}

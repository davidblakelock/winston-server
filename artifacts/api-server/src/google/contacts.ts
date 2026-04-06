import { google } from "googleapis";
import { getAuthClient, hasContactsScope } from "./oauth.js";
import { logger } from "../lib/logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
}

export interface ContactSearchResult {
  contacts: Contact[];
  needsReauth: boolean;
}

export async function searchContacts(searchQuery: string): Promise<ContactSearchResult> {
  try {
    // Check if the contacts scope is in David's stored token before hitting the API.
    // The scope was added after his initial auth so his token won't have it until he
    // reconnects Google via Settings → Reconnect Google.
    const hasScope = await hasContactsScope();
    if (!hasScope) {
      logger.warn("[CONTACTS] contacts.readonly scope not in stored token — David needs to reconnect Google");
      return { contacts: [], needsReauth: true };
    }

    const auth = await getAuthClient();
    if (!auth) {
      logger.warn("[CONTACTS] No auth client available");
      return { contacts: [], needsReauth: false };
    }

    const people = google.people({ version: "v1", auth });

    const resp = await people.people.searchContacts({
      query: searchQuery,
      readMask: "names,emailAddresses,phoneNumbers",
      pageSize: 5,
    });

    const results = resp.data.results ?? [];
    const contacts = results
      .map((r) => {
        const person = r.person;
        if (!person) return null;
        return {
          name: person.names?.[0]?.displayName ?? "",
          email: person.emailAddresses?.[0]?.value,
          phone: person.phoneNumbers?.[0]?.value,
        };
      })
      .filter((c): c is Contact => c !== null && c.name.length > 0);

    logger.info({ query: searchQuery, found: contacts.length }, "[CONTACTS] Search complete");
    return { contacts, needsReauth: false };
  } catch (err: unknown) {
    const status = (err as Record<string, unknown>)?.code;
    if (status === 403 || status === 401) {
      logger.warn("[CONTACTS] API returned 403/401 — contacts scope not active on this token");
      return { contacts: [], needsReauth: true };
    }
    logger.error({ err }, "[CONTACTS] Search failed");
    return { contacts: [], needsReauth: false };
  }
}

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
      `\n\n[Google Contacts — Search: "${query}"]\n` +
      `No contacts found matching "${query}". ` +
      `Tell David no one by that name was found in his Google contacts, and ask if he'd like to try a different spelling.`
    );
  }

  const lines = result.contacts.map((c) => {
    const details: string[] = [];
    if (c.email) details.push(`email: ${c.email}`);
    if (c.phone) details.push(`phone: ${c.phone}`);
    return `• ${c.name}${details.length ? " — " + details.join(" | ") : ""}`;
  });

  return (
    `\n\n[Google Contacts — Search: "${query}"]\n` +
    `${lines.join("\n")}\n` +
    `Read the contact's name, phone, and email naturally. ` +
    `If David asks to save this person to his Winston profile, confirm before saving.`
  );
}

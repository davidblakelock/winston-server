import { google } from "googleapis";
import { getAuthClient } from "./oauth.js";
import { logger } from "../lib/logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
}

export async function searchContacts(searchQuery: string): Promise<Contact[]> {
  try {
    const auth = await getAuthClient();
    if (!auth) {
      logger.warn("[CONTACTS] No auth client available");
      return [];
    }

    const people = google.people({ version: "v1", auth });

    const resp = await people.people.searchContacts({
      query: searchQuery,
      readMask: "names,emailAddresses,phoneNumbers",
      pageSize: 5,
    });

    const results = resp.data.results ?? [];
    return results
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
  } catch (err: unknown) {
    const status = (err as Record<string, unknown>)?.code;
    if (status === 403 || status === 401) {
      logger.warn("[CONTACTS] Contacts scope not granted — David needs to reconnect Google");
    } else {
      logger.error({ err }, "[CONTACTS] Search failed");
    }
    return [];
  }
}

export function formatContactsForPrompt(contacts: Contact[], query: string): string {
  if (contacts.length === 0) {
    return `\n\n[Google Contacts — Search: "${query}"]\nNo contacts found matching that name. David may need to reconnect Google with contacts access enabled.`;
  }
  const lines = contacts.map((c) => {
    const details: string[] = [];
    if (c.email) details.push(`email: ${c.email}`);
    if (c.phone) details.push(`phone: ${c.phone}`);
    return `• ${c.name}${details.length ? " — " + details.join(" | ") : ""}`;
  });
  return `\n\n[Google Contacts — Search: "${query}"]\n${lines.join("\n")}`;
}

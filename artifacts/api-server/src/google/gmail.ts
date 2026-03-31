import { google } from "googleapis";
import { getAuthClient } from "./oauth.js";

export interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

function decodeHeader(encoded: string): string {
  return encoded.replace(/=\?UTF-8\?[BQ]\?([^?]+)\?=/gi, (_, b64) => {
    try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return b64; }
  });
}

export async function fetchRecentEmails(maxResults = 8): Promise<EmailSummary[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "in:inbox is:unread -category:promotions -category:social",
    labelIds: ["INBOX"],
  });

  const messages = list.data.messages ?? [];
  if (messages.length === 0) return [];

  const emails: EmailSummary[] = [];

  for (const msg of messages.slice(0, maxResults)) {
    if (!msg.id) continue;
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers ?? [];
    const get = (name: string) =>
      decodeHeader(headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "");

    const rawFrom = get("From");
    const fromMatch = rawFrom.match(/^(.*?)\s*<[^>]+>/) ?? null;
    const from = fromMatch ? fromMatch[1].trim().replace(/^"(.*)"$/, "$1") : rawFrom;

    emails.push({
      from,
      subject: get("Subject") || "(no subject)",
      snippet: detail.data.snippet ?? "",
      date: get("Date"),
    });
  }

  return emails;
}

export function formatEmailsForPrompt(emails: EmailSummary[]): string {
  if (emails.length === 0) return "Inbox is clear — no unread messages.";
  return emails
    .map((e, i) => `${i + 1}. From: ${e.from} | Subject: ${e.subject} | ${e.snippet.slice(0, 120)}`)
    .join("\n");
}

import { google } from "googleapis";
import { getAuthClient, getAuthClientForUser } from "./oauth.js";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface EmailSummary {
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  date: string;
  gmailId: string;
  gmailThreadId: string;
}

function decodeHeader(encoded: string): string {
  return encoded.replace(/=\?UTF-8\?[BQ]\?([^?]+)\?=/gi, (_, b64) => {
    try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return b64; }
  });
}

// ── Scam / Phishing Detection ─────────────────────────────────────────────────

const TRUSTED_BRAND_DOMAINS: Record<string, string[]> = {
  "chase":        ["chase.com"],
  "bank of america": ["bankofamerica.com"],
  "wells fargo":  ["wellsfargo.com"],
  "citibank":     ["citi.com", "citibank.com"],
  "paypal":       ["paypal.com"],
  "amazon":       ["amazon.com"],
  "apple":        ["apple.com", "icloud.com"],
  "microsoft":    ["microsoft.com", "live.com", "outlook.com"],
  "google":       ["google.com", "googlemail.com", "gmail.com"],
  "irs":          ["irs.gov"],
  "social security": ["ssa.gov"],
  "medicare":     ["medicare.gov", "cms.hhs.gov"],
  "fedex":        ["fedex.com"],
  "ups":          ["ups.com"],
  "usps":         ["usps.com"],
  "netflix":      ["netflix.com"],
  "facebook":     ["facebook.com", "meta.com"],
  "instagram":    ["instagram.com"],
  "venmo":        ["venmo.com"],
  "zelle":        ["zellepay.com"],
  "docusign":     ["docusign.com", "docusign.net"],
  "coinbase":     ["coinbase.com"],
};

const URGENCY_SUBJECT_WORDS = [
  "urgent", "action required", "immediately", "account suspended", "account closed",
  "verify your account", "confirm your account", "update your information",
  "you have won", "winner", "prize", "claim your", "selected", "congratulations",
  "final notice", "last chance", "your account has been", "suspicious activity",
  "unusual sign-in", "security alert", "unauthorized access",
  "invoice attached", "payment failed", "past due", "overdue",
];

const URGENCY_BODY_WORDS = [
  "click here to verify", "click the link below", "confirm your password",
  "enter your credentials", "provide your social security",
  "gift card", "itunes card", "google play card", "wire transfer",
  "western union", "moneygram", "cryptocurrency", "bitcoin",
  "call immediately", "do not share this code", "one-time password",
  "your account will be closed", "your account will be suspended",
  "limited time", "expires in 24 hours", "act now",
];

const FREE_EMAIL_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "live.com", "protonmail.com", "mail.com", "ymail.com",
];

// Known legitimate senders that commonly trigger false positives
const WHITELIST_DOMAINS = [
  "google.com", "gmail.com", "apple.com", "icloud.com", "microsoft.com",
  "outlook.com", "live.com", "amazon.com", "netflix.com", "facebook.com",
  "instagram.com", "twitter.com", "x.com", "linkedin.com",
];

function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim().toLowerCase() : raw.trim().toLowerCase();
}

function extractDomain(email: string): string {
  const atIdx = email.lastIndexOf("@");
  return atIdx >= 0 ? email.slice(atIdx + 1).toLowerCase() : "";
}

function hasTyposquatting(domain: string): { suspected: string } | null {
  const knownBrands = ["paypal", "amazon", "apple", "microsoft", "google",
    "chase", "netflix", "facebook", "instagram", "ebay"];
  for (const brand of knownBrands) {
    if (domain.includes(brand)) continue; // exact match is fine
    // Levenshtein distance check for close misspellings
    for (const variant of generateTypos(brand)) {
      if (domain.includes(variant)) {
        return { suspected: brand };
      }
    }
  }
  return null;
}

function generateTypos(word: string): string[] {
  const typos: string[] = [];
  // Common substitutions
  typos.push(word.replace(/a/g, "4").replace(/e/g, "3").replace(/i/g, "1").replace(/o/g, "0"));
  // Remove one char
  for (let i = 0; i < word.length; i++) {
    typos.push(word.slice(0, i) + word.slice(i + 1));
  }
  return typos.filter((t) => t !== word && t.length >= 3);
}

export interface ScamAnalysis {
  isSuspicious: boolean;
  riskLevel: "high" | "medium" | "low";
  flags: string[];
  summary: string;
}

export function analyzeEmailForScam(email: {
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
}): ScamAnalysis {
  const flags: string[] = [];
  const domain = extractDomain(email.fromEmail);
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const snippetLower = email.snippet.toLowerCase();
  const combined = `${subjectLower} ${snippetLower}`;

  // Skip whitelisted domains entirely for brand mismatch checks
  const isWhitelisted = WHITELIST_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));

  // 1. Brand/display name vs domain mismatch
  if (!isWhitelisted) {
    for (const [brand, trustedDomains] of Object.entries(TRUSTED_BRAND_DOMAINS)) {
      const claimsBrand = fromLower.includes(brand) || subjectLower.includes(brand);
      if (claimsBrand) {
        const domainMatch = trustedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
        if (!domainMatch && domain !== "") {
          flags.push(`Claims to be from "${brand}" but sent from ${domain}`);
        }
      }
    }

    // 2. Free email domain sending as institution
    if (FREE_EMAIL_DOMAINS.includes(domain)) {
      const claimsInstitution =
        fromLower.match(/bank|paypal|amazon|apple|microsoft|irs|medicare|government|fedex|ups|usps/i);
      if (claimsInstitution) {
        flags.push(`Institution impersonation: display name "${email.from}" using free email domain (${domain})`);
      }
    }

    // 3. Typosquatting on domain
    const typo = hasTyposquatting(domain);
    if (typo) {
      flags.push(`Sender domain "${domain}" may be impersonating ${typo.suspected}`);
    }
  }

  // 4. Urgency language in subject
  for (const word of URGENCY_SUBJECT_WORDS) {
    if (subjectLower.includes(word)) {
      flags.push(`Urgent/suspicious subject language: "${word}"`);
      break; // one flag per category is enough
    }
  }

  // 5. Phishing/scam body language
  for (const phrase of URGENCY_BODY_WORDS) {
    if (combined.includes(phrase)) {
      flags.push(`Suspicious body content: "${phrase}"`);
      break;
    }
  }

  // 6. Requests for personal info / credentials
  if (combined.match(/\b(password|ssn|social security number|credit card|cvv|pin\b|account number)\b/i)) {
    flags.push("Requests sensitive personal information (password, SSN, credit card, etc.)");
  }

  // 7. Prize / lottery scam
  if (combined.match(/\b(you('?ve| have) (won|been selected)|claim (your |a )?(prize|reward|gift)|lottery|sweepstakes)\b/i)) {
    flags.push("Prize or lottery scam language detected");
  }

  // 8. Gift card requests
  if (combined.match(/\b(gift card|itunes|google play|amazon gift|steam card|prepaid card)\b/i) &&
      combined.match(/\b(send|buy|purchase|pay|get)\b/i)) {
    flags.push("Requests payment via gift cards");
  }

  // 9. Suspicious no-reply or random domains
  if (!isWhitelisted && domain && domain.match(/^\d{1,3}-\d{1,3}|random|temp|noreply\d+|\.xyz$|\.top$|\.click$|\.loan$|\.work$|\.buzz$/)) {
    flags.push(`Sender uses suspicious domain pattern: ${domain}`);
  }

  const isSuspicious = flags.length > 0;
  let riskLevel: "high" | "medium" | "low" = "low";

  if (flags.length >= 3 || (flags.length >= 2 && flags.some((f) => f.includes("impersonation") || f.includes("Claims to be")))) {
    riskLevel = "high";
  } else if (flags.length >= 1) {
    riskLevel = "medium";
  }

  const summary = isSuspicious
    ? `${riskLevel === "high" ? "High-risk" : "Potentially suspicious"} email: ${flags.slice(0, 2).join("; ")}`
    : "Appears legitimate";

  return { isSuspicious, riskLevel, flags, summary };
}

// ── Email last-checked tracking ───────────────────────────────────────────────

/**
 * Returns the last time David's emails were checked, or null if never tracked.
 * Used to show only NEW emails since the last check on manual email requests.
 */
export async function getEmailLastChecked(userName = NATIVE_STORED_NAME): Promise<Date | null> {
  try {
    const { rows } = await query<{ last_checked_at: Date }>(
      `SELECT last_checked_at FROM email_tracking WHERE user_name = $1`,
      [userName]
    );
    return rows.length > 0 ? new Date(rows[0].last_checked_at) : null;
  } catch {
    return null;
  }
}

/**
 * Updates the last-checked timestamp to now. Call immediately after a successful
 * on-demand email fetch so subsequent checks only show new messages.
 */
export async function updateEmailLastChecked(userName = NATIVE_STORED_NAME): Promise<void> {
  try {
    await query(
      `INSERT INTO email_tracking (user_name, last_checked_at) VALUES ($1, NOW())
       ON CONFLICT (user_name) DO UPDATE SET last_checked_at = NOW()
       RETURNING user_name`,
      [userName]
    );
  } catch (err) {
    console.warn("[Gmail] Failed to update email_tracking:", err);
  }
}

/**
 * Unified email fetch used by BOTH the morning briefing and the manual email check.
 * Fetches the most recent inbox emails regardless of read status, sorted by date
 * descending (newest first). Both code paths use this so behaviour is identical.
 * @param since  If provided, only return emails received after this timestamp.
 */
export async function fetchAndSummarizeEmails(maxResults = 15, since?: Date, userName?: string): Promise<EmailSummary[] | null> {
  const fetchStart = new Date();
  console.log(`[Gmail] fetchAndSummarizeEmails called at ${fetchStart.toISOString()} — maxResults=${maxResults}${userName ? ` user=${userName}` : ""}`);

  const auth = userName ? await getAuthClientForUser(userName) : await getAuthClient();
  if (!auth) {
    console.warn("[Gmail] No auth client — Google not connected");
    return null;
  }

  try {
    const tokenResult = await auth.getAccessToken();
    if (!tokenResult.token) {
      console.warn("[Gmail] getAccessToken returned empty token — refresh may have failed");
    } else {
      console.log("[Gmail] Token OK — proceeding with Gmail API call");
    }
  } catch (refreshErr) {
    console.error("[Gmail] Token refresh failed — aborting Gmail fetch:", refreshErr);
    return null;
  }

  const gmail = google.gmail({ version: "v1", auth });

  // Build query: explicitly exclude trash and spam, unread only.
  // When `since` is provided (on-demand manual check), restrict to emails after that timestamp.
  // For the morning briefing (no `since`), fetch ALL unread emails — no time cutoff.
  let gmailQuery = "in:inbox -in:trash -in:spam is:unread";
  if (since) {
    const epochSeconds = Math.floor(since.getTime() / 1000);
    gmailQuery += ` after:${epochSeconds}`;
    console.log(`[Gmail] since mode — fetching unread emails after ${since.toISOString()} (epoch ${epochSeconds})`);
  }
  // No else — briefing path gets all unread with no time restriction

  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: gmailQuery,
  });

  const messages = list.data.messages ?? [];
  console.log(`[Gmail] fetchAndSummarizeEmails: messages.list returned ${messages.length} messages`);
  if (messages.length === 0) return [];

  // Fetch all message details in parallel — previously sequential (one await per message)
  // which added ~300-500ms per email. Parallel cuts this to a single network round-trip.
  const msgList = messages.slice(0, maxResults).filter((msg) => !!msg.id);
  const details = await Promise.all(
    msgList.map((msg) =>
      gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      })
    )
  );

  const emails: EmailSummary[] = details.map((detail) => {
    const headers = detail.data.payload?.headers ?? [];
    const get = (name: string) =>
      decodeHeader(headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "");

    const rawFrom = get("From");
    const fromEmail = extractEmailAddress(rawFrom);
    const fromMatch = rawFrom.match(/^(.*?)\s*<[^>]+>/) ?? null;
    const from = fromMatch ? fromMatch[1].trim().replace(/^"(.*)"$/, "$1") : rawFrom;

    return {
      from,
      fromEmail,
      subject: get("Subject") || "(no subject)",
      snippet: detail.data.snippet ?? "",
      date: get("Date"),
      gmailId: detail.data.id ?? "",
      gmailThreadId: detail.data.threadId ?? "",
    };
  });

  const fetchDurationMs = Date.now() - fetchStart.getTime();
  const mostRecentDate = emails.length > 0 ? emails[0].date : "(none in last 7d)";
  console.log(`[Gmail] fetchAndSummarizeEmails: most recent email date = ${mostRecentDate}`);
  console.log(
    `[Gmail] fetchAndSummarizeEmails complete — ${emails.length} inbox emails (all unread, no trash/spam) in ${fetchDurationMs}ms` +
    ` — most recent: ${mostRecentDate}`
  );

  return emails;
}

export async function fetchRecentEmails(maxResults = 10): Promise<EmailSummary[] | null> {
  const fetchStart = new Date();
  console.log(`[Gmail] fetchRecentEmails called at ${fetchStart.toISOString()} — maxResults=${maxResults}`);

  const auth = await getAuthClient();
  if (!auth) {
    console.warn("[Gmail] No auth client — Google not connected");
    return null;
  }

  // ── Explicit token refresh before every call ───────────────────────────────
  // The access token expires after 1 hour. We call getAccessToken() which
  // automatically refreshes via the stored refresh_token if the current
  // access_token is expired. This prevents silent failures on stale tokens.
  try {
    const tokenResult = await auth.getAccessToken();
    if (!tokenResult.token) {
      console.warn("[Gmail] getAccessToken returned empty token — refresh may have failed");
    } else {
      console.log("[Gmail] Token OK — proceeding with Gmail API call");
    }
  } catch (refreshErr) {
    console.error("[Gmail] Token refresh failed — aborting Gmail fetch:", refreshErr);
    return null;
  }

  const gmail = google.gmail({ version: "v1", auth });

  // ── Fetch most recent 10 unread emails, no category filtering ─────────────
  // Removed: -category:promotions -category:social (was excluding forwarded emails)
  // Removed: labelIds: ["INBOX"] (was double-filtering and missing some inboxes)
  // Result order: newest first by default (Gmail API returns by internalDate desc)
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "is:unread",
  });

  const messages = list.data.messages ?? [];
  console.log(`[Gmail] messages.list returned ${messages.length} messages`);
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
    const fromEmail = extractEmailAddress(rawFrom);
    const fromMatch = rawFrom.match(/^(.*?)\s*<[^>]+>/) ?? null;
    const from = fromMatch ? fromMatch[1].trim().replace(/^"(.*)"$/, "$1") : rawFrom;
    const subject = get("Subject") || "(no subject)";
    const snippet = detail.data.snippet ?? "";
    const date = get("Date");

    emails.push({ from, fromEmail, subject, snippet, date, gmailId: msg.id ?? "", gmailThreadId: detail.data.threadId ?? "" });
  }

  // ── Diagnostic: log fetch summary ─────────────────────────────────────────
  const mostRecentDate = emails[0]?.date ?? "none";
  const fetchDurationMs = Date.now() - fetchStart.getTime();
  console.log(
    `[Gmail] Fetch complete — ${emails.length} emails returned in ${fetchDurationMs}ms` +
    ` — most recent: ${mostRecentDate}`
  );

  return emails;
}

export function formatEmailsForPrompt(emails: EmailSummary[]): string {
  if (emails.length === 0) return "Inbox is clear — no unread messages.";
  const lines: string[] = ["UNREAD EMAILS:"];
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    lines.push(`${i + 1}. From: ${e.from} | Subject: ${e.subject} | ${e.snippet.slice(0, 120)}`);
  }
  return lines.join("\n");
}

export function buildImportantEmailInstruction(
  emails: EmailSummary[],
  _companionName?: string | null,
  _userName?: string | null,
): string {
  if (emails.length === 0) return "";
  return (
    `\n\nEMAIL PRESENTATION INSTRUCTIONS:\n` +
    `Present emails that need attention clearly and concisely — no lengthy commentary or opinions. ` +
    `For each actionable email, state: who it's from, what it needs, and offer ONE specific action.\n` +
    `Format each actionable email like this:\n` +
    `• [From] — [what it needs] → [specific offer: "Want me to draft a reply?" or "This needs your attention"]\n\n` +
    `For meeting requests: offer to draft a reply or check calendar availability.\n` +
    `For emails needing a reply: offer to draft the reply, read it back for approval before sending.\n` +
    `For calendar invites: offer to accept, decline, or check for conflicts.\n` +
    `For bills/deadlines: flag the amount/date, ask if they want a reminder set.\n` +
    `For newsletters/promotions: skip entirely or mention in one brief line at the end.\n\n` +
    `CRITICAL: Be brief and action-oriented. No lengthy summaries, no opinions about email content. ` +
    `Present the facts, offer the action, wait for the user's response. ` +
    `The user can say "delete that", "mark it read", "remind me about that" and you should handle it naturally.`
  );
}


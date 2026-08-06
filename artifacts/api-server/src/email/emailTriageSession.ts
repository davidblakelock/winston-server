import type { EmailSummary } from "../google/gmail.js";
import { logger } from "../lib/logger.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface EmailTriageSession {
  emails: EmailSummary[];
  currentIndex: number;
  createdAt: number;
}

const _sessions = new Map<string, EmailTriageSession>();

export function getTriageSession(userName: string): EmailTriageSession | null {
  const s = _sessions.get(userName);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    _sessions.delete(userName);
    return null;
  }
  return s;
}

export function setTriageSession(userName: string, session: EmailTriageSession | null): void {
  if (session === null) {
    _sessions.delete(userName);
    logger.info({ userName }, "[EmailTriage] Session cleared");
  } else {
    _sessions.set(userName, session);
    logger.info({ userName, count: session.emails.length, index: session.currentIndex }, "[EmailTriage] Session set");
  }
}

export function getCurrentTriageEmail(userName: string): EmailSummary | null {
  const s = getTriageSession(userName);
  if (!s) return null;
  return s.emails[s.currentIndex] ?? null;
}

export function advanceTriageSession(userName: string): EmailSummary | null {
  const s = getTriageSession(userName);
  if (!s) return null;
  const next = s.currentIndex + 1;
  if (next >= s.emails.length) {
    setTriageSession(userName, null);
    return null;
  }
  s.currentIndex = next;
  // Refresh so the TTL is a sliding idle timeout, not a fixed lifetime from
  // whenever the session started. Without this, createdAt never moved past
  // the first email, so a longer triage (more emails, replies composed
  // along the way) could genuinely expire right as the user reaches the
  // last few — at which point getTriageSession starts returning null, the
  // [Active Email Triage] context stops being injected, Claude has no
  // gmailId left to act on, and no amount of the user re-explaining what
  // they want fixes it, since the server has lost track of which email
  // they mean.
  s.createdAt = Date.now();
  _sessions.set(userName, s);
  logger.info({ userName, nextIndex: next }, "[EmailTriage] Advanced");
  return s.emails[next];
}

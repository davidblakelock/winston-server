import type { EmailSummary } from "../google/gmail.js";
import { logger } from "../lib/logger.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface EmailSession {
  emails: EmailSummary[];
  currentIndex: number;
  handledIds: Set<string>;
  createdAt: number;
}

const _emailSessionMap = new Map<string, EmailSession>();

export function getEmailSession(userName: string): EmailSession | null {
  const session = _emailSessionMap.get(userName);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    _emailSessionMap.delete(userName);
    logger.info({ userName }, "[EmailSession] Session expired — cleared");
    return null;
  }
  return session;
}

export function setEmailSession(userName: string, state: EmailSession | null): void {
  if (state === null) {
    _emailSessionMap.delete(userName);
    logger.info({ userName }, "[EmailSession] Session cleared");
  } else {
    _emailSessionMap.set(userName, state);
    logger.info({ userName, count: state.emails.length, index: state.currentIndex }, "[EmailSession] Session updated");
  }
}

export function getCurrentEmail(userName: string): EmailSummary | null {
  const session = getEmailSession(userName);
  if (!session) return null;
  return session.emails[session.currentIndex] ?? null;
}

export function advanceEmailSession(userName: string): EmailSummary | null {
  const session = getEmailSession(userName);
  if (!session) return null;
  // Find next unhandled email
  let next = session.currentIndex + 1;
  while (next < session.emails.length && session.handledIds.has(session.emails[next].gmailId)) {
    next++;
  }
  if (next >= session.emails.length) {
    // All done
    setEmailSession(userName, null);
    return null;
  }
  session.currentIndex = next;
  _emailSessionMap.set(userName, session);
  logger.info({ userName, nextIndex: next }, "[EmailSession] Advanced to next email");
  return session.emails[next];
}

export function markEmailHandled(userName: string, gmailId: string): void {
  const session = getEmailSession(userName);
  if (!session) return;
  session.handledIds.add(gmailId);
  _emailSessionMap.set(userName, session);
  logger.info({ userName, gmailId }, "[EmailSession] Email marked handled");
}

/**
 * Shared authentication middleware for Winston API routes.
 *
 * Two valid auth paths:
 *   1. x-api-key: winston-native-2026  →  native mobile app bypass.
 *      The caller MUST also supply x-user-name to identify the user.
 *      Falls back to "David" only for backward compatibility with older app builds.
 *   2. Authorization: Bearer <token>   →  standard session token (any provider)
 *
 * Returns the resolved userName string, or sends a 401 and returns null.
 */
import type { Request, Response } from "express";
import { validateSession } from "./sessionAuth.js";
import { logger } from "../lib/logger.js";

export const NATIVE_API_KEY = "winston-native-2026";
/** Backward-compat default for native app routes that don't carry x-user-name.
 *  Points to the primary Google-authenticated account. Old native builds that
 *  omit x-user-name will use this; new builds should send the header explicitly.
 */
export const NATIVE_USER = "davidblakelock";

function resolveNativeUser(req: Request): string {
  const headerUser = req.headers["x-user-name"];
  if (typeof headerUser === "string" && headerUser.trim()) {
    return headerUser.trim();
  }
  // Backward compat: older native builds don't send x-user-name
  return NATIVE_USER;
}

export async function authenticate(
  req: Request,
  res: Response
): Promise<string | null> {
  if (req.headers["x-api-key"] === NATIVE_API_KEY) {
    return resolveNativeUser(req);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }

  const session = await validateSession(authHeader.slice(7)).catch((err) => {
    logger.warn({ err }, "[AUTH] middleware — validateSession threw");
    return null;
  });

  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return null;
  }

  return session.userName;
}

/**
 * Lightweight variant that never sends a 401 — used for routes that PREFER
 * auth but fall back gracefully (e.g. the profile-photo endpoint).
 * Returns null if no valid session is found.
 */
export async function tryAuthenticate(req: Request): Promise<string | null> {
  if (req.headers["x-api-key"] === NATIVE_API_KEY) {
    return resolveNativeUser(req);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const session = await validateSession(authHeader.slice(7)).catch(() => null);
  return session?.userName ?? null;
}

/**
 * Single source of truth for the canonical username and all legacy aliases.
 *
 * Imported by both sessionAuth.ts (applies resolution at the DB layer) and
 * middleware.ts (belt-and-suspenders for the native API-key path).
 *
 * Adding a new alias here is the ONLY change needed to handle a renamed user.
 */

/** The one and only canonical username for the primary user. */
export const NATIVE_USER = "davidblakelock";

/**
 * Every legacy username variant the system may have stored historically.
 * All values map to NATIVE_USER.
 */
const USER_ALIASES: Record<string, string> = {
  David: NATIVE_USER,
  david: NATIVE_USER,
  "David Blakelock": NATIVE_USER,
  davidBlakelock: NATIVE_USER,
};

/**
 * Resolve any legacy username alias to the canonical NATIVE_USER.
 * Unknown names pass through unchanged (safe for multi-user futures).
 */
export function resolveUserAlias(name: string): string {
  return USER_ALIASES[name] ?? name;
}

/**
 * Return every username that maps to the given canonical name, plus the
 * canonical name itself. Used by clearGoogleTokensForUser so a DELETE
 * hits both the canonical row and any legacy-named rows.
 */
export function getUserAliasNames(canonicalName: string): string[] {
  const aliases = Object.entries(USER_ALIASES)
    .filter(([, v]) => v === canonicalName)
    .map(([k]) => k);
  return [canonicalName, ...aliases];
}

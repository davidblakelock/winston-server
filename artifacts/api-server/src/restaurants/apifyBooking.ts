// ── Global API key (server-level, not per-user) ───────────────────────────────
function getApiKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }

export function isApifyApiKeyConfigured(): boolean {
  return !!getApiKey();
}

/** True when the Apify API key is configured (no user credentials needed for guest booking). */
export function isOpenTableReady(): boolean {
  return !!getApiKey();
}

// ── Result type ───────────────────────────────────────────────────────────────
// Shared with resyAuth.ts, which implements Resy booking directly (no Apify actor).

export interface ApifyBookingResult {
  success: boolean;
  confirmationNumber?: string;
  restaurantName?: string;
  date?: string;
  time?: string;
  partySize?: number;
  /** Returned when the requested slot is taken but alternatives are available. */
  alternatives?: Array<{ time: string }>;
  /** Machine-readable reason when success=false. */
  error?: string;
}

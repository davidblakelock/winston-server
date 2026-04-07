import { logger } from "../lib/logger.js";

export async function ensureProactiveMessageLogTable(): Promise<void> {
  // Table kept for compatibility with other proactive message types
}

export function startPickleballScheduler(): void {
  logger.info("Pickleball scheduler started (check-in disabled)");
}

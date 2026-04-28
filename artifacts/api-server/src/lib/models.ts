/**
 * Anthropic model constants for Winston API server.
 *
 * RULE: All new Anthropic API calls must use one of these two models.
 *   - MODEL_HAIKU  — default for everything (extraction, parsing, formatting, summaries,
 *                    scheduled tasks, simple generation). Fast and cheap.
 *   - MODEL_SONNET — only when complex reasoning, multi-step planning, or high-quality
 *                    creative output is required (morning briefing delivery, calendar
 *                    parsing, evening wind-down, text composition, profile analysis).
 *
 * Never use Opus in production.
 */

export const MODEL_HAIKU  = "claude-haiku-4-5-20251001" as const;
export const MODEL_SONNET = "claude-sonnet-4-6" as const;

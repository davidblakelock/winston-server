import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrefKey =
  | "politics"
  | "stocks"
  | "sports"
  | "local_events"
  | "music_events"
  | "weather"
  | "email"
  | "tv_shows"
  | "motivation"
  | "story_questions"
  | "journal"
  | "news";

export type PrefValue = "on" | "off" | "less" | "more";

export interface BriefingPreference {
  prefKey: PrefKey;
  prefValue: PrefValue;
  updatedAt: Date;
}

export interface BriefingPrefOp {
  key: PrefKey;
  value: PrefValue;
}

// ── DB Setup ──────────────────────────────────────────────────────────────────

export async function ensureBriefingPreferencesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS briefing_preferences (
      id serial PRIMARY KEY,
      user_name text NOT NULL,
      pref_key text NOT NULL,
      pref_value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, pref_key)
    )
  `);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getBriefingPreferences(
  userName: string
): Promise<BriefingPreference[]> {
  const { rows } = await query<{
    pref_key: string;
    pref_value: string;
    updated_at: Date;
  }>(
    `SELECT pref_key, pref_value, updated_at
     FROM briefing_preferences
     WHERE user_name = $1
     ORDER BY updated_at DESC`,
    [userName]
  );
  return rows.map((r) => ({
    prefKey: r.pref_key as PrefKey,
    prefValue: r.pref_value as PrefValue,
    updatedAt: r.updated_at,
  }));
}

export async function upsertBriefingPreference(
  userName: string,
  key: PrefKey,
  value: PrefValue
): Promise<void> {
  await query(
    `INSERT INTO briefing_preferences (user_name, pref_key, pref_value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_name, pref_key)
     DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = NOW()
     RETURNING user_name`,
    [userName, key, value]
  );
}

export async function resetBriefingPreference(
  userName: string,
  key: PrefKey
): Promise<void> {
  await query(
    `DELETE FROM briefing_preferences WHERE user_name = $1 AND pref_key = $2 RETURNING user_name`,
    [userName, key]
  );
}

// ── Convenience checks ────────────────────────────────────────────────────────

export async function isStoryQuestionsEnabled(userName: string): Promise<boolean> {
  const { rows } = await query<{ pref_value: string }>(
    `SELECT pref_value FROM briefing_preferences
     WHERE user_name = $1 AND pref_key = 'story_questions'`,
    [userName]
  );
  if (rows.length === 0) return true; // default: on
  return rows[0].pref_value !== "off";
}

export async function isJournalPromptsEnabled(userName: string): Promise<boolean> {
  const { rows } = await query<{ pref_value: string }>(
    `SELECT pref_value FROM briefing_preferences
     WHERE user_name = $1 AND pref_key = 'journal'`,
    [userName]
  );
  if (rows.length === 0) return true; // default: on
  return rows[0].pref_value !== "off";
}

// ── Intent Detection ──────────────────────────────────────────────────────────

// Broad gate — catch anything that sounds like a briefing/wind-down preference change.
export const BRIEFING_PREF_PATTERN =
  /\b(less|fewer|more|no |skip|stop|don'?t|disable|turn off|remove|exclude|hide|without|include|enable|turn on|add back|bring back)\b.{0,50}\b(politic|news|stock|market|sport|weather|local event|email|tv.?show|music event|concert|motivat|story.?question|journal|wind.?down|briefing)\b|\b(story.?question|journal.?prompt|nightly.?question|night.?question|memory.?question).{0,40}\b(stop|off|disable|no more|skip)\b/i;

const VALID_KEYS: PrefKey[] = [
  "politics", "stocks", "sports", "local_events", "music_events",
  "weather", "email", "tv_shows", "motivation", "story_questions",
  "journal", "news",
];
const VALID_VALUES: PrefValue[] = ["on", "off", "less", "more"];

export async function extractBriefingPrefOp(
  message: string
): Promise<BriefingPrefOp | null> {
  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 128,
    system: `Extract a briefing preference change from the user's message.

Valid keys:
- "politics" — political news, US politics, politicians
- "stocks" — stock market, S&P, Dow, Nasdaq, financial markets
- "sports" — sports results (Rangers, Cowboys, etc.)
- "local_events" — Dallas local news and events, what's happening locally
- "music_events" — venue concerts, upcoming shows, live music
- "weather" — weather forecast sections
- "email" — email summary in briefing
- "tv_shows" — TV episode mentions
- "motivation" — morning inspiration/motivation section
- "story_questions" — evening memory/story questions for Olivia
- "journal" — evening journal prompts
- "news" — entire national/world news section

Valid values:
- "off" → skip/stop/no/disable/remove
- "on"  → include/enable/add back/bring back
- "less" → less of it, tone it down, fewer
- "more" → more of it, additional coverage

Return ONLY a JSON object: { "key": <key>, "value": <value> }
If no clear preference change is expressed, return null.
Return raw JSON only — no markdown.`,
    messages: [{ role: "user", content: message }],
  });

  const raw =
    result.content[0].type === "text" ? result.content[0].text.trim() : "";
  if (!raw || raw === "null") return null;

  try {
    const parsed = JSON.parse(raw) as { key: string; value: string };
    if (!VALID_KEYS.includes(parsed.key as PrefKey)) return null;
    if (!VALID_VALUES.includes(parsed.value as PrefValue)) return null;
    return { key: parsed.key as PrefKey, value: parsed.value as PrefValue };
  } catch {
    return null;
  }
}

// ── System Prompt Block ───────────────────────────────────────────────────────

const PREF_INSTRUCTIONS: Record<PrefKey, Record<PrefValue, string>> = {
  politics: {
    off:   "SKIP all political news stories — do not mention US politics, politicians, Congress, the White House, elections, or political parties anywhere in the briefing.",
    less:  "Minimise political content — include only the single most impactful political story if absolutely essential; skip routine political news.",
    more:  "Give extra coverage to political news — include 2–3 political stories if available.",
    on:    "Include political news as normal.",
  },
  stocks: {
    off:   "SKIP all market and stock content — do not mention S&P 500, Dow, Nasdaq, stock prices, or financial markets.",
    less:  "Keep market mentions very brief — one sentence at most; skip detailed numbers.",
    more:  "Give expanded market coverage — include index movements, notable movers, and market sentiment.",
    on:    "Include market and stock content as normal.",
  },
  sports: {
    off:   "SKIP Section 10 (Sports) entirely — do not mention any game results, scores, or sports outcomes.",
    less:  "Keep sports to one sentence only — mention the most recent result briefly.",
    more:  "Give expanded sports coverage — include full game summaries and upcoming schedules.",
    on:    "Include sports as normal.",
  },
  local_events: {
    off:   "SKIP Section 11 (Dallas Local Events) — do not mention local news or events.",
    less:  "Keep Dallas local content to one item only — the single most relevant item.",
    more:  "Expand Section 11 — share 3–4 local Dallas items instead of the usual 1–2.",
    on:    "Include Dallas local events as normal.",
  },
  music_events: {
    off:   "SKIP Section 12 (Music Events / Venue Concerts) entirely.",
    less:  "Mention upcoming concerts only if they are at a saved venue and match a favourite artist.",
    more:  "Expand music events — include all upcoming concerts at any of the saved venues.",
    on:    "Include music events as normal.",
  },
  weather: {
    off:   "SKIP Sections 2 and 3 (Weather and Forecast) entirely. Do not mention weather anywhere.",
    less:  "Condense weather to a single sentence: current temp and one notable condition only.",
    more:  "Give full expanded weather detail — include hourly feel, extended forecast, and all secondary city weather.",
    on:    "Include weather as normal.",
  },
  email: {
    off:   "SKIP Section 5 (Email) entirely — do not mention the inbox or any emails.",
    less:  "Mention email only if there is something urgent or directly actionable.",
    more:  "Summarise up to 3 emails instead of the usual 1–2.",
    on:    "Include email as normal.",
  },
  tv_shows: {
    off:   "SKIP all TV show mentions — do not reference any episodes, series, or streaming content.",
    less:  "Mention a TV episode only if it is a season premiere or finale.",
    more:  "Highlight all new episodes for tracked shows.",
    on:    "Include TV show episodes as normal.",
  },
  motivation: {
    off:   "SKIP Section 14 (Morning Motivation / Inspiration) entirely.",
    less:  "Keep motivation to one short sentence — a brief thought only.",
    more:  "Give a fuller inspiration moment — share the quote and a meaningful personal connection to the day.",
    on:    "Include morning motivation as normal.",
  },
  story_questions: {
    off:   "EVENING CHECK-IN: Do NOT ask any story or memory questions for Olivia tonight.",
    less:  "EVENING CHECK-IN: Only ask a story question if the evening conversation is calm and unhurried.",
    more:  "EVENING CHECK-IN: Prioritise the memory question for Olivia — make it a warm central moment.",
    on:    "Ask story questions during evening check-in as normal.",
  },
  journal: {
    off:   "EVENING CHECK-IN: Do NOT offer a journal prompt tonight.",
    less:  "EVENING CHECK-IN: Only offer journaling if David seems reflective and in the mood.",
    more:  "EVENING CHECK-IN: Actively invite David to journal — frame it as an important habit.",
    on:    "Offer journal prompts during evening check-in as normal.",
  },
  news: {
    off:   "SKIP Section 8 (News) entirely — do not mention any news headlines or stories.",
    less:  "Condense news to 3 headlines maximum — only the most significant stories.",
    more:  "Include a fuller news sweep — all 8 headline categories plus any available watercooler or entertainment.",
    on:    "Include news as normal.",
  },
};

export function buildBriefingPrefsBlock(
  prefs: BriefingPreference[],
  userName: string
): string {
  if (prefs.length === 0) return "";

  const instructions = prefs
    .filter((p) => PREF_INSTRUCTIONS[p.prefKey]?.[p.prefValue])
    .map((p) => `• ${PREF_INSTRUCTIONS[p.prefKey][p.prefValue]}`)
    .join("\n");

  if (!instructions) return "";

  return (
    `\n\n[Briefing Preferences — configured by ${userName}]\n` +
    `Apply these personalisation rules throughout this briefing:\n` +
    instructions +
    `\nThese are standing preferences — follow them precisely.`
  );
}

// ── Human-readable confirmation ───────────────────────────────────────────────

export function confirmationMessage(key: PrefKey, value: PrefValue): string {
  const CONFIRMS: Record<PrefKey, Record<PrefValue, string>> = {
    politics: {
      off:  "Got it — I'll skip political news in your briefings from now on.",
      less: "Got it — I'll keep political news minimal going forward.",
      more: "Got it — I'll give you more political coverage in your briefings.",
      on:   "Got it — political news is back to normal in your briefings.",
    },
    stocks: {
      off:  "Done — I'll skip the stock market in your briefings.",
      less: "Done — I'll keep market mentions very brief.",
      more: "Done — I'll give you fuller market coverage each morning.",
      on:   "Done — markets are back to normal in your briefings.",
    },
    sports: {
      off:  "Done — I'll skip sports results in your briefings.",
      less: "Done — I'll keep sports to just the highlights.",
      more: "Done — you'll get fuller sports coverage going forward.",
      on:   "Done — sports is back to normal in your briefings.",
    },
    local_events: {
      off:  "Done — I'll skip Dallas local news in your briefings.",
      less: "Done — I'll keep local events to just the most relevant item.",
      more: "Done — I'll expand the Dallas local section for you.",
      on:   "Done — local events are back to normal.",
    },
    music_events: {
      off:  "Done — I'll skip the upcoming concerts section.",
      less: "Done — I'll only flag concerts for your favourite artists.",
      more: "Done — I'll give you fuller venue and concert coverage.",
      on:   "Done — music events are back to normal.",
    },
    weather: {
      off:  "Done — I'll skip weather in your briefings.",
      less: "Done — I'll keep weather to one quick sentence.",
      more: "Done — you'll get a fuller weather picture each morning.",
      on:   "Done — weather is back to normal.",
    },
    email: {
      off:  "Done — I'll skip the email section in your briefings.",
      less: "Done — I'll only flag emails that need action.",
      more: "Done — I'll summarise more of your inbox each morning.",
      on:   "Done — email is back to normal in your briefings.",
    },
    tv_shows: {
      off:  "Done — I'll skip TV show mentions in your briefings.",
      less: "Done — I'll only mention season premieres and finales.",
      more: "Done — I'll highlight all new episodes for your shows.",
      on:   "Done — TV shows are back to normal.",
    },
    motivation: {
      off:  "Done — I'll skip the morning inspiration section.",
      less: "Done — I'll keep motivation to just a brief line.",
      more: "Done — you'll get a richer inspiration moment each morning.",
      on:   "Done — morning motivation is back to normal.",
    },
    story_questions: {
      off:  "Done — I won't ask story questions for Olivia during the evening.",
      less: "Done — I'll only ask a story question when the moment feels right.",
      more: "Done — I'll make the memory question a meaningful part of each evening.",
      on:   "Done — evening story questions are back on.",
    },
    journal: {
      off:  "Done — I won't offer journal prompts in the evening.",
      less: "Done — I'll only suggest journaling when you seem reflective.",
      more: "Done — I'll actively invite you to journal each evening.",
      on:   "Done — evening journal prompts are back on.",
    },
    news: {
      off:  "Got it — I'll skip the news section in your briefings.",
      less: "Got it — I'll keep news to just 3 headlines going forward.",
      more: "Got it — I'll give you a fuller news sweep each morning.",
      on:   "Got it — news is back to normal in your briefings.",
    },
  };
  return CONFIRMS[key]?.[value] ?? "Done — I've saved that preference.";
}

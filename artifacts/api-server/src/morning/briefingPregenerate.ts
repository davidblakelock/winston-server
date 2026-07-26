import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { getProfileItems, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";
import { getStoicForUser } from "../stoic/stoicManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { getGoals } from "../goals/goalsManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";

// ── Experimental: single-call GPT-4o daily brief via Responses API + web search ──
// NOT wired into _doBriefingPrefetch, the cron schedule, or any other live path.
// Build-only step — call manually to test before it replaces the existing
// news/weather/sports/local-content pipeline in a later pass.

const DAILY_BRIEF_INSTRUCTION = `You are about to write a morning briefing. Before writing anything, perform FOUR SEPARATE web searches, one topic at a time — do not combine them into one query, and do not search using the biographical context block that follows this instruction (that block is background for personalizing the writing later, not a search query).

SEARCH 1 — National news: search for today's top news headlines. Aim for at least 5 real stories worth knowing — major national and international stories only. Do not include hyper-local news from a single city or small region — local government votes, local development projects, local tribal/community news.

SEARCH 2 — Sports: search for this person's teams' most recent completed games (the specific team names are in the context block below — use them as the search terms, e.g. "[team name] score last night"). Report only FINAL scores from the most recently completed game per team — last night's game if one was played, otherwise their most recent prior game.

SEARCH 3 — Markets: search for stock futures and overnight financial news ahead of today's open (e.g. "stock futures today", "Dow S&P Nasdaq futures").

SEARCH 4 — Weird/funny story: search for a genuinely funny or delightful "you won't believe this" news story from today.

Weather is NOT something to search for — verified current weather conditions for this person's city are already provided in the context block below. Use that data as-is; do not search for weather, do not guess, and do not include a multi-day forecast.

This briefing is delivered in the early morning, before the stock market opens for the day. Sports scores should always be from yesterday's/last night's completed games — never describe a game as happening "today" unless you've confirmed via search that it already occurred earlier the same calendar day in this person's timezone. Never give a live/current stock quote or price snapshot — the market is closed at this hour and a snapshot price is meaningless.

After completing all four searches above, write a genuinely enjoyable five-minute morning brief covering: the news from Search 1, the verified weather data from the context block, the markets info from Search 3, the sports scores from Search 2, and the story from Search 4. Use only real, current, verified information from your searches (and the verified weather data) — never invent facts, venues, dates, scores, or weather. Style it however reads best for a five-minute morning read — sections, headers, or flowing prose, your call, and vary the structure day to day rather than repeating an identical template every time. Keep individual news items tight — a sentence or two each, like the examples below, not a full paragraph of explanation per story. "Five-minute read" means concise and scannable across many short items, not long-form writing on each one. Overall length should come from covering enough distinct topics (news, weather, markets, sports, a fun story, quote), not from writing at length about any single one of them.

SPORTS: Format each as: team, final score, opponent. Do not mention upcoming games, schedules, or say a team is "set to play today" — this section covers only what already happened, never what's coming up.

MARKETS & INVESTING: Do not give a live price snapshot or quote — the market hasn't opened yet at this hour. Instead, cover futures direction for the major indices (Dow, S&P, Nasdaq) ahead of today's open, and any major overnight financial news likely to move the market at open — earnings reports, Fed commentary, major economic data releases, or significant geopolitical developments affecting markets. Frame this as what the trading day ahead holds, not a snapshot of where things stood at some overnight timestamp — don't reference a specific time or timezone for any price or figure.

FORMATTING — CRITICAL: Write in clean, plain, readable prose only — this will be read aloud via text-to-speech, so it must sound natural when spoken. Never include citation brackets, markdown links, raw URLs, "utm_source" parameters, "#:~:text=" fragment identifiers, or any link syntax anywhere in the output. When you want to credit a source, say it in plain spoken words woven into the sentence — e.g. "according to the AP" or "Axios reports" — never as a clickable link or bracketed reference. Do NOT include a "Sources:" section, footer, bibliography, or list of links anywhere, including at the end. The entire output must read as clean spoken prose from start to finish with zero raw URLs or citation markup of any kind.

For loose style reference only (not a required template), here are two briefings this person said they liked:

(These examples are showing you TONE AND STRUCTURE ONLY. Every fact, story, quote, and detail in your actual output must come from your own fresh search results for today. Do not reuse, paraphrase, or reproduce ANY specific fact, story, or detail from these examples — including the dog-on-a-mountain story — under any circumstances. If your search doesn't turn up a good "weird news" story, skip that section entirely rather than reusing the example. Any place names, cities, venues, team opponents, scores, or story details shown in brackets below are placeholders — never use a real one from these examples in your actual output. All real content — including location, teams, scores, and stories — must come from your own search and from the person's actual current city and teams given above.)

[EXAMPLE 1]
☕ David's Daily Brief
Friday, July 17, 2026
Good morning! Here's your five-minute briefing.

🌎 The 5 Stories That Matter
1. U.S.–Iran conflict remains the dominant global story
The conflict continued overnight with additional U.S. strikes and Iranian retaliation against U.S. facilities in the region. Markets remain focused on whether the fighting expands and what it could mean for global energy supplies.
2. AI stock selloff is accelerating
Investors are questioning whether the enormous spending on AI infrastructure will translate into profits. Semiconductor stocks were hit across Asia, Europe, and U.S. premarket trading despite strong earnings from some chipmakers.
3. Oil remains elevated
Crude prices continue to trade at relatively high levels because of Middle East tensions. While supplies have not been significantly disrupted, energy markets remain sensitive to any escalation.
4. Air quality concerns across parts of the U.S.
Smoke from wildfires is affecting air quality in portions of the Midwest and Northeast, leading to health advisories in several areas.
5. Earnings season is shifting market leadership
After several quarters dominated by AI enthusiasm, investors are paying closer attention to whether companies can actually convert AI investments into sustained profits.

📈 Markets & Investing
Futures point [direction] ahead of the open for the Dow, S&P 500, and Nasdaq. The overnight story to watch: [a real earnings report, Fed comment, economic data release, or geopolitical development likely to move markets today]. Investor takeaway: [one sentence of context for a long-term investor].

🏈🏀⚾ Pro Sports
Last night's results for [this person's home teams]: [Team] beat [Opponent], final score [X–Y]. [Team] fell to [Opponent], final score [X–Y]. [Team] defeated [Opponent], final score [X–Y]. Internationally, [a real result from a competition this person follows].

🤖 AI & Technology
The biggest AI story today isn't a new model — it's the market. Investors are asking whether the hundreds of billions being spent on AI chips, data centers, and infrastructure will generate enough profits to justify current valuations. That debate is driving today's technology selloff.

😂 No Politics, Just Weird
[a real, current lighthearted news story — something genuinely funny or delightful from today's search, not invented]

💬 Quote of the Day
"The important thing is not to stop questioning." — Albert Einstein

👍 Things You Can Safely Ignore
Every dramatic prediction that "AI is over" — the technology continues to advance, even if the stocks experience periods of volatility. Also, hour-by-hour market swings — if you're investing for years rather than days, today's headlines are usually much less important than they seem.

Have a great Friday!

End with today's Stoic quote provided above, woven in naturally as a closing thought, not just pasted verbatim.`;

// Server-side safety net — the prompt's anti-link/citation instructions are
// demonstrably not followed reliably (observed citation/URL leakage despite
// explicit instructions against it). Backstop, not a replacement for the prompt.
function sanitizeBriefText(text: string): string {
  return text
    // Markdown links [label](url) → keep just the label
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    // Bracketed citation numbers, e.g. [1] or [1, 2]
    .replace(/\[\d+(?:,\s*\d+)*\]/g, "")
    // Bare URLs carrying a utm_source tracking parameter
    .replace(/https?:\/\/\S*utm_source[^\s)]*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

interface OpenAiResponsesResult {
  status?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

// Resolves coordinates for the daily-brief weather lookup. Live GPS
// (last_known_lat/lon) is preferred when present since it reflects where the
// person actually is right now; falls back to their onboarding home
// coordinates, then the older bare latitude/longitude columns, and finally
// geocodes the city name as a last resort.
async function resolveWeatherCoords(
  city: string,
  locationContext: { lat: number | null; lon: number | null } | null,
  profile: { latitude: number | null; longitude: number | null; homeLatitude: number | null; homeLongitude: number | null } | null
): Promise<{ lat: number; lon: number } | null> {
  if (locationContext?.lat != null && locationContext?.lon != null) {
    return { lat: locationContext.lat, lon: locationContext.lon };
  }
  if (profile?.homeLatitude != null && profile?.homeLongitude != null) {
    return { lat: profile.homeLatitude, lon: profile.homeLongitude };
  }
  if (profile?.latitude != null && profile?.longitude != null) {
    return { lat: profile.latitude, lon: profile.longitude };
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`,
      { headers: { "User-Agent": "WinstonCompanion/1.0" }, signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (data.length) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch {
    // fall through
  }
  return null;
}

// ── Shared context-gathering — used by both generateDailyBrief and
// generateDailyBriefDeepResearch so the two don't duplicate this logic ──────
async function buildDailyBriefContext(userName: string): Promise<string> {
  const [profile, goals, profileItems, memories, stoic] = await Promise.all([
    getProfile(userName).catch(() => null),
    getGoals(userName).catch((): Awaited<ReturnType<typeof getGoals>> => []),
    getProfileItems(undefined, userName).catch((): Awaited<ReturnType<typeof getProfileItems>> => []),
    getRecentMemories(7).catch(() => []),
    getStoicForUser(userName).catch(() => null),
  ]);

  const name = profile?.name ?? userName;
  const locationContext = await getUserLocationContext(userName).catch(() => null);
  const city = locationContext?.city ?? profile?.city ?? "an unknown city";
  const tz = locationContext?.timezone ?? profile?.timezone ?? "UTC";

  let weatherLine = "Not available — do not include a weather section, and do not guess conditions.";
  try {
    const coords = await resolveWeatherCoords(city, locationContext, profile);
    if (coords) {
      const w = await getCachedWeather(city, coords.lat, coords.lon, tz);
      weatherLine = `${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition}, ${w.precipChance}% chance of rain, high ${w.high}°F / low ${w.low}°F.`;
    }
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] Weather fetch failed");
  }

  const interestParts: string[] = [];
  if (profile?.hobbies?.length)        interestParts.push(`hobbies: ${profile.hobbies.join(", ")}`);
  if (profile?.musicGenres?.length)    interestParts.push(`music genres: ${profile.musicGenres.join(", ")}`);
  if (profile?.favoriteArtists?.length) interestParts.push(`favorite artists: ${profile.favoriteArtists.join(", ")}`);
  if (profile?.sportsTeams)            interestParts.push(`sports teams: ${profile.sportsTeams}`);
  const interestsLine = interestParts.length > 0 ? interestParts.join("; ") : "no specific interests on file";

  const profileItemsBlock = formatProfileForContext(profileItems);

  const activeGoals = goals.filter((g) => !g.completed_at);
  const goalsLine = activeGoals.length > 0
    ? activeGoals.map((g) => {
        const incompleteSteps = g.steps.filter((s) => !s.completed_at);
        const stepsText = incompleteSteps.length > 0
          ? incompleteSteps.map((s) => s.step_text).join("; ")
          : "no open steps";
        const desc = g.description ? ` — ${g.description}` : "";
        return `"${g.title}"${desc} (next steps: ${stepsText})`;
      }).join(" | ")
    : "no active goals";

  const memoriesBlock = formatMemoriesForContext(memories);
  const stoicLine = stoic ? `"${stoic.quote}" — ${stoic.author} (${stoic.source})` : "none available today";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return (
`Today's date: ${today}
Name: ${name}
City: ${city}
VERIFIED WEATHER DATA for ${city} (use exactly this — do not search for or guess weather): ${weatherLine}
Interests: ${interestsLine}
Active goals: ${goalsLine}
${profileItemsBlock}
Recent context: ${memoriesBlock || "no recent conversation memories"}
Today's reflection: ${stoicLine}`
  );
}

// Below this many real web_search_call events, the run is treated as
// unreliable (the model likely took a shortcut instead of doing the four
// distinct searches asked for) and gets one retry with a stronger nudge.
const MIN_SEARCH_CALLS = 3;

async function callDailyBriefApi(
  apiKey: string,
  input: string,
  userName: string
): Promise<{ text: string | null; searchCallCount: number }> {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      tool_choice: "required",
      input,
      max_output_tokens: 4000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    logger.warn(
      { userName, status: resp.status, errText: errText.slice(0, 500) },
      "[DailyBrief] OpenAI Responses API returned non-OK status"
    );
    return { text: null, searchCallCount: 0 };
  }

  const data = await resp.json() as OpenAiResponsesResult;

  const searchCallCount = Array.isArray(data.output)
    ? data.output.filter((item) => item.type === "web_search_call").length
    : 0;
  logger.info(
    { userName, searchCallCount, totalOutputItems: Array.isArray(data.output) ? data.output.length : 0 },
    "[DailyBrief] Search call count for this run"
  );
  if (Array.isArray(data.output)) {
    data.output.forEach((item, i) => {
      if (item.type === "web_search_call") {
        logger.info(
          { userName, index: i, querySummary: JSON.stringify(item).slice(0, 500) },
          "[DailyBrief] Search call detail"
        );
      }
    });
  }

  const messageItem = data.output?.find((item) => item.type === "message");
  const textItem = messageItem?.content?.find((c) => c.type === "output_text" || c.type === "text");

  if (!textItem?.text) {
    logger.warn(
      { userName, raw: JSON.stringify(data).slice(0, 500) },
      "[DailyBrief] Unexpected Responses API shape — no output_text found"
    );
    return { text: null, searchCallCount };
  }

  return { text: sanitizeBriefText(textItem.text), searchCallCount };
}

export async function generateDailyBrief(userName: string): Promise<string | null> {
  try {
    const contextBlock = await buildDailyBriefContext(userName);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn({ userName }, "[DailyBrief] OPENAI_API_KEY not configured — skipping");
      return null;
    }

    // Instructions first, context block second — the model was observed
    // treating the biographical context block itself as a search query when
    // it came first, instead of the several distinct searches the
    // instructions ask for.
    const baseInput = `${DAILY_BRIEF_INSTRUCTION}\n\n${contextBlock}`;

    let result = await callDailyBriefApi(apiKey, baseInput, userName);

    if (result.searchCallCount < MIN_SEARCH_CALLS) {
      logger.warn(
        { userName, searchCallCount: result.searchCallCount },
        "[DailyBrief] Too few search calls on first attempt — retrying with a stronger nudge"
      );
      const retryInput =
        `${baseInput}\n\nYour previous attempt only performed ${result.searchCallCount} search(es) before writing. ` +
        `That is not enough. Go back and perform all four searches listed above (news, sports, markets, weird story) ` +
        `as separate, well-formed queries before writing your final answer.`;
      const retryResult = await callDailyBriefApi(apiKey, retryInput, userName);
      if (retryResult.text && retryResult.searchCallCount >= result.searchCallCount) {
        result = retryResult;
      }
    }

    return result.text;
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] generateDailyBrief failed");
    return null;
  }
}

// ── Deep-research alternative — o4-mini-deep-research via background mode + polling ──
// NOT wired into _doBriefingPrefetch, the cron schedule, or the chatHandlerCore.ts
// morning_rundown test case. Manually test-callable only, for comparison against
// generateDailyBrief above.

const DEEP_RESEARCH_POLL_INTERVAL_MS = 15_000;
const DEEP_RESEARCH_MAX_POLLS = 80; // 80 * 15s = 20 minutes total

export async function generateDailyBriefDeepResearch(userName: string): Promise<string | null> {
  try {
    const contextBlock = await buildDailyBriefContext(userName);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn({ userName }, "[DailyBriefDeepResearch] OPENAI_API_KEY not configured — skipping");
      return null;
    }

    const submitResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "o4-mini-deep-research",
        background: true,
        tools: [{ type: "web_search_preview" }],
        input: `${contextBlock}\n\n${DAILY_BRIEF_INSTRUCTION}`,
        max_output_tokens: 8000,
      }),
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text().catch(() => "");
      logger.warn(
        { userName, status: submitResp.status, errText: errText.slice(0, 500) },
        "[DailyBriefDeepResearch] Submission returned non-OK status"
      );
      return null;
    }

    const submitData = await submitResp.json() as { id?: string; status?: string };
    const responseId = submitData.id;
    if (!responseId) {
      logger.warn(
        { userName, raw: JSON.stringify(submitData).slice(0, 500) },
        "[DailyBriefDeepResearch] No response id in submission — cannot poll"
      );
      return null;
    }

    logger.info(
      { userName, responseId, initialStatus: submitData.status },
      "[DailyBriefDeepResearch] Background request submitted — polling for completion"
    );

    for (let poll = 0; poll < DEEP_RESEARCH_MAX_POLLS; poll++) {
      await new Promise<void>((resolve) => setTimeout(resolve, DEEP_RESEARCH_POLL_INTERVAL_MS));

      const pollResp = await fetch(`https://api.openai.com/v1/responses/${responseId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${apiKey}` },
      });

      if (!pollResp.ok) {
        const errText = await pollResp.text().catch(() => "");
        logger.warn(
          { userName, responseId, status: pollResp.status, errText: errText.slice(0, 500) },
          "[DailyBriefDeepResearch] Poll returned non-OK status"
        );
        continue;
      }

      const pollData = await pollResp.json() as OpenAiResponsesResult;

      const pollCount = poll + 1;
      logger.info(
        { userName, responseId, status: pollData.status, poll: pollCount },
        "[DailyBriefDeepResearch] Poll status"
      );

      if (pollData.status === "completed") {
        logger.info(
          { userName, responseId, fullRawResponse: JSON.stringify(pollData) },
          "[DailyBriefDeepResearch] DIAGNOSTIC — full raw completed response"
        );
        if (Array.isArray(pollData.output)) {
          pollData.output.forEach((item, i) => {
            logger.info(
              { userName, responseId, index: i, itemType: item.type, itemSummary: JSON.stringify(item).slice(0, 2000) },
              "[DailyBriefDeepResearch] DIAGNOSTIC — output item"
            );
          });
        }

        const messageItem = pollData.output?.find((item) => item.type === "message");
        const textItem = messageItem?.content?.find((c) => c.type === "output_text" || c.type === "text");

        if (!textItem?.text) {
          logger.warn(
            { userName, responseId, raw: JSON.stringify(pollData).slice(0, 500) },
            "[DailyBriefDeepResearch] Unexpected Responses API shape — no output_text found"
          );
          return null;
        }

        return textItem.text;
      }

      if (pollData.status === "failed" || pollData.status === "cancelled") {
        logger.warn(
          { userName, responseId, status: pollData.status, raw: JSON.stringify(pollData).slice(0, 500) },
          "[DailyBriefDeepResearch] Background request did not complete successfully"
        );
        return null;
      }

      logger.info(
        { userName, responseId, status: pollData.status ?? "unknown", poll: poll + 1 },
        "[DailyBriefDeepResearch] Still in progress — polling again"
      );
    }

    logger.warn(
      { userName, responseId },
      "[DailyBriefDeepResearch] Timed out after 20 minutes of polling — giving up"
    );
    return null;
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBriefDeepResearch] generateDailyBriefDeepResearch failed");
    return null;
  }
}

// ── gpt-5-search-api alternative — Chat Completions API, always searches ──────
// A third, separate function for comparison against generateDailyBrief and
// generateDailyBriefDeepResearch above. Unlike the Responses API's
// web_search_preview tool used elsewhere in this file, gpt-5-search-api always
// retrieves web information before responding — no tool_choice needed.
// Not wired into chatHandlerCore.ts yet — manually test-callable only, via
// /api/admin/test-daily-brief-searchapi.

interface ChatCompletionsResult {
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: unknown;
    };
  }>;
}

export async function generateDailyBriefSearchApi(userName: string): Promise<string | null> {
  try {
    const contextBlock = await buildDailyBriefContext(userName);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn({ userName }, "[DailyBriefSearchApi] OPENAI_API_KEY not configured — skipping");
      return null;
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-search-api",
        web_search_options: {},
        messages: [
          { role: "user", content: `${contextBlock}\n\n${DAILY_BRIEF_INSTRUCTION}` },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      logger.warn(
        { userName, status: resp.status, errText: errText.slice(0, 1000) },
        "[DailyBriefSearchApi] OpenAI Chat Completions API returned non-OK status"
      );
      return null;
    }

    const data = await resp.json() as ChatCompletionsResult;

    logger.info(
      { userName, fullRawResponse: JSON.stringify(data) },
      "[DailyBriefSearchApi] DIAGNOSTIC — full raw Chat Completions output"
    );

    const message = data.choices?.[0]?.message;
    logger.info(
      { userName, hasAnnotations: message?.annotations !== undefined, annotations: JSON.stringify(message?.annotations ?? null).slice(0, 1000) },
      "[DailyBriefSearchApi] DIAGNOSTIC — search evidence on message"
    );

    const text = message?.content;
    if (!text) {
      logger.warn(
        { userName, raw: JSON.stringify(data).slice(0, 1000) },
        "[DailyBriefSearchApi] Unexpected Chat Completions shape — no message content found"
      );
      return null;
    }

    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBriefSearchApi] generateDailyBriefSearchApi failed");
    return null;
  }
}

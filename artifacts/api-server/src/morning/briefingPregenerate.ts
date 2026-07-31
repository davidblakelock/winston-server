import Anthropic from "@anthropic-ai/sdk";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { getProfileItems, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";
import { getStoicForUser } from "../stoic/stoicManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { getGoals } from "../goals/goalsManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import { MODEL_SONNET } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Daily brief via Claude + web_search (the live Morning Run Down path) ──────
// Was OpenAI's Responses API + web_search_preview with tool_choice: "required".
// Diagnosed and replaced: that tool does not reliably decompose a compound
// instruction into distinct, well-formed searches — verified directly by
// inspecting the actual query sent to the tool, which was the raw instruction
// text itself (sometimes 100+ words), not a real search phrase, even when
// explicitly told to formulate a short query first. Claude's web_search tool,
// already used successfully elsewhere in this codebase, was tested against
// the same compound instruction and reliably issued multiple real, distinct,
// well-formed queries — including autonomous follow-up searches to refine a
// weak result. That's the actual fix; the instruction content below is
// largely unchanged except for the interest-search addition and the
// exclusion list restored to Search 1.

function buildDailyBriefInstruction(interestPicks: string[]): string {
  const interestSearchBlock = interestPicks.length > 0
    ? `\n\nSEARCH 1b — Personal interest news: search specifically for recent news connected to: ${interestPicks.join(", ")}. This is in addition to Search 1a, not instead of it — the goal is to surface something genuinely newsworthy tied to what this person actually cares about. If nothing real turns up, that's fine — don't force it.`
    : "";

  return `You are about to write a morning briefing. Before writing anything, perform the searches below as separate, well-formed queries, one topic at a time — do not combine them into one query, and do not search using the biographical context block that follows this instruction (that block is background for personalizing the writing later, not a search query).

SEARCH 1a — National news: search for today's top US and world news headlines. Aim for 10 real stories worth knowing — major national and international stories only. Do not include hyper-local news from a single city or small region — local government votes, local development projects, local tribal/community news. Exclude stock market and business-finance stories here — that's covered separately in Search 3 — and exclude AI industry/tech company news (product launches, funding rounds, model releases) unless it's genuinely historic.${interestSearchBlock}

When choosing the final list of stories, prefer genuinely important news, but when two stories are similarly newsworthy, favor the one connected to this person's actual interests over an equally routine but disconnected one. If Search 1b turned up something real and relevant, fold it into the same numbered list rather than giving it a separate section.

SEARCH 2 — Sports: search for this person's teams' most recent completed games (the specific team names are in the context block below — use them as the search terms, e.g. "[team name] score last night"). Report only FINAL scores from the most recently completed game per team — last night's game if one was played, otherwise their most recent prior game.

SEARCH 3 — Markets: search for stock futures and overnight financial news ahead of today's open (e.g. "stock futures today", "Dow S&P Nasdaq futures").

SEARCH 4 — Weird/funny story: search for a genuinely funny or delightful news story from today. Not politics. Not crime. Not celebrity gossip. Not trivia facts. A real story with a specific person or place and an unexpected twist — something a person could mention at lunch and get a genuine reaction.

SEARCH 5 — Joke of the day: search for a fresh, clean, corny joke — dad-joke register specifically, pun-based or setup-and-punchline, the kind of joke that gets a groan and a smile at the same time. Never political, never edgy, never off-color, nothing that needs a content warning. Genuinely shareable — the kind of thing you'd actually repeat to someone else ("hey, did you hear the one about...").

Weather is NOT something to search for — verified current weather conditions for this person's city are already provided in the context block below. Use that data as-is; do not search for weather, do not guess, and do not include a multi-day forecast.

This briefing is delivered in the early morning, before the stock market opens for the day. Sports scores should always be from yesterday's/last night's completed games — never describe a game as happening "today" unless you've confirmed via search that it already occurred earlier the same calendar day in this person's timezone. Never give a live/current stock quote or price snapshot — the market is closed at this hour and a snapshot price is meaningless.

After completing all searches above, write a genuinely enjoyable Morning Run Down covering: the news from Search 1, the verified weather data from the context block, the markets info from Search 3, the sports scores from Search 2, the story from Search 4, and the joke from Search 5. Use only real, current, verified information from your searches (and the verified weather data) — never invent facts, venues, dates, scores, or weather. Style it however reads best — sections, headers, or flowing prose, your call, and vary the structure day to day rather than repeating an identical template every time. Overall length should come from covering enough distinct topics (news, weather, markets, sports, a fun story, a joke, quote), not from writing at length about any single one of them.

NEWS ITEM LENGTH — HARD LIMIT: Each of the 10 news items gets a headline plus exactly ONE sentence underneath it — no exceptions, this is a hard cap, not a target to aim for. That one sentence is a single grammatical sentence ending in one period — not two clauses stitched together with a semicolon or "and," not a sentence followed by a second one on the next line. Before moving to the next item, check what you wrote: if there are two periods (other than one at the very end) or two separate lines of body text, you have written too much — cut it down to one sentence and move on. This is the single most important formatting rule in this entire prompt.

NEUTRALITY — CRITICAL: Report only the concrete fact of what happened (who, what, when) — never characterize it, never editorialize, never take a side or imply one is right, never speculate on motives or consequences, never use loaded or opinionated language. This applies to every item, political or not, and applies even when the search results themselves are framed with opinion or analysis — strip that out and report just the underlying fact. Specifically banned: reaction/framing sentences or clauses tacked onto the fact, like "a serious escalation," "not a new headline, but...," "worth flagging," "tough one," "wine country in crisis," or any other editorial aside — if you catch yourself writing one, delete it rather than keep it as a second sentence. The one sentence you keep is always the fact itself, never your reaction to the fact.

SPORTS: Format each as: team, final score, opponent. Do not mention upcoming games, schedules, or say a team is "set to play today" — this section covers only what already happened, never what's coming up.

MARKETS & INVESTING: Do not give a live price snapshot or quote — the market hasn't opened yet at this hour. Instead, cover futures direction for the major indices (Dow, S&P, Nasdaq) ahead of today's open, and any major overnight financial news likely to move the market at open — earnings reports, Fed commentary, major economic data releases, or significant geopolitical developments affecting markets. Frame this as what the trading day ahead holds, not a snapshot of where things stood at some overnight timestamp — don't reference a specific time or timezone for any price or figure.

JOKE OF THE DAY: Give the joke from Search 5 on its own, straight — setup, then punchline. Don't explain why it's funny, don't apologize for it ("okay, this one's bad, but..."), don't over-introduce it. Corny is the point; let it land as corny. If Search 5 didn't turn up anything genuinely clean and shareable, skip this section entirely rather than forcing a weak one.

FORMATTING — CRITICAL: Write in clean, plain, readable prose only — this will be read aloud via text-to-speech, so it must sound natural when spoken. Never include citation brackets, markdown links, raw URLs, "utm_source" parameters, "#:~:text=" fragment identifiers, or any link syntax anywhere in the output. When you want to credit a source, say it in plain spoken words woven into the sentence — e.g. "according to the AP" or "Axios reports" — never as a clickable link or bracketed reference. Do NOT include a "Sources:" section, footer, bibliography, or list of links anywhere, including at the end. The entire output must read as clean spoken prose from start to finish with zero raw URLs or citation markup of any kind. Do not include any meta-commentary about your own process anywhere in the output — no "Got everything I need, now let me write the briefing," no "Let me search for...", nothing describing what you're about to do or just did. Begin directly with the greeting line, nothing before it.

For loose style reference only (not a required template), here is a briefing this person said they liked:

(This example is showing you TONE AND STRUCTURE ONLY. Every fact, story, quote, and detail in your actual output must come from your own fresh search results for today. Do not reuse, paraphrase, or reproduce ANY specific fact, story, or detail from this example under any circumstances. If your search doesn't turn up a good "weird news" story or a good joke, skip that section entirely rather than reusing the example. Any place names, cities, venues, team opponents, scores, jokes, or story details shown in brackets below are placeholders — never use a real one from this example in your actual output. All real content — including location, teams, scores, stories, the joke, the framing line, and the My Life line — must come from your own search and fresh writing for today, never copied from this example.)

[EXAMPLE 1]
☕ David's Daily Brief
Friday, July 17, 2026
Good morning! Here's your Morning Run Down.

🌎 The Stories That Matter (aim for 10 — this example shows 5 for brevity; write out the full set you found)
1. U.S.–Iran conflict remains the dominant global story
Overnight brought additional U.S. strikes and Iranian retaliation against U.S. facilities in the region.
2. Major flooding displaces thousands in Southeast Asia
Torrential rains have overwhelmed river systems across the region, forcing large-scale evacuations.
3. Oil remains elevated
Crude prices continue to trade at relatively high levels amid Middle East tensions.
4. Air quality concerns across parts of the U.S.
Smoke from wildfires is affecting air quality in portions of the Midwest and Northeast, prompting health advisories.
5. New peace talks announced for an ongoing regional conflict
Diplomats from several countries are set to meet this week to discuss a ceasefire.

📈 Markets & Investing
Futures point [direction] ahead of the open for the Dow, S&P 500, and Nasdaq. The overnight story to watch: [a real earnings report, Fed comment, economic data release, or geopolitical development likely to move markets today]. Investor takeaway: [one sentence of context for a long-term investor].

🏈🏀⚾ Pro Sports
Last night's results for [this person's home teams]: [Team] beat [Opponent], final score [X–Y]. [Team] fell to [Opponent], final score [X–Y]. Internationally, [a real result from a competition this person follows].

😂 No Politics, Just Weird
[a real, current lighthearted news story — something genuinely funny or delightful from today's search, not invented]

😄 Joke of the Day
[a real, fresh, clean dad joke from today's search — setup and punchline, no explanation]

Before I go — [one fresh sentence naming the morning-preparation practice itself, loosely touching one or two real Stoic themes as background, never a checklist, never the same combination as yesterday]

💬 Quote of the Day
"The important thing is not to stop questioning." — Albert Einstein
[one plain-language sentence on what it actually means today, modern and wry, not lecturing]

[one soft, brief, optional line naming "My Life" explicitly as the place to go — describing the act of capturing a quick thought there, never using the word "journal," one honest reason Winston can notice patterns over time, zero guilt, reads as an open door]

Have a great Friday!

Close the briefing with these three pieces, in order:

1. FRAMING LINE — before the quote, write one fresh sentence naming the practice itself: people setting their head straight before the day starts, the way Marcus Aurelius did every morning before stepping into whatever Rome had for him that day. Let it loosely draw on real Stoic morning-practice ideas as background texture — mental preparation for what's ahead, the dichotomy of control (focusing only on what's actually yours to steer), gratitude for the day itself — but never list them out or read them like a checklist ("today, focus on what you control and be grateful"). Pick a different angle or combination each day; never repeat the same combination or the same sentence shape twice. This is one sentence, not a paragraph, and it leads into the quote — it doesn't summarize or preview what the quote says.

2. QUOTE + TRANSLATION — today's Stoic quote provided above, delivered essentially as given — the exact words, attributed naturally (e.g. "As Marcus Aurelius put it..." or "Epictetus wrote..."). Immediately after, in exactly ONE sentence, give your own plain-language read on what it actually means today. Match this register: treat the idea as a piece of working technology, not ancient wisdom to admire from a distance — a framework built to run a mind, the way you'd describe a good system or process. Modern, a little wry, confident — never lecturing, never "ancient Rome," never "the Stoics believed," no philosophy jargon. Vary the phrasing and the metaphor day to day — don't lean on the same framing every morning.

3. MY LIFE NUDGE — after the quote and translation, close with one brief, soft, fully optional line pointing at My Life by name — this must name "My Life" explicitly, as the actual place in the app to go do this, not a vague gesture like "onto a page somewhere" or "jot it down." My Life is a place to capture a quick thought about the day, in your own words. Rules that matter here: never use the word "journal" or "journaling" anywhere — describe the act itself (jotting something down, capturing a line, getting a thought out of your head) instead of naming the genre. Give one honest, brief reason it's worth doing — Winston can start noticing real patterns in it over time — without overselling it. Zero guilt: no streaks, no "you haven't done this in a while," no implication that skipping it is a lapse. It should read like an open door someone's welcome to walk through, not a task with your name on it. Vary the exact wording day to day rather than repeating a fixed line — but "My Life" itself, as the named destination, should appear every time. This is the last thing in the briefing.`;
}

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

  // Aspirational goals are deliberately excluded from the daily brief — they
  // aren't being actively worked, so "next steps" framing doesn't fit them.
  const activeGoals = goals.filter((g) => g.status === "active");
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

// Rotates through hobbies/music genres/favorite artists (sports teams are
// already covered by Search 2, so left out here) so the interest-driven
// search targets something different day to day rather than the same pick
// every time. Deterministic on day-of-year — no state to track.
async function getDailyInterestPicks(userName: string, count = 2): Promise<string[]> {
  const profile = await getProfile(userName).catch(() => null);
  const pool = [
    ...(profile?.hobbies ?? []),
    ...(profile?.musicGenres ?? []),
    ...(profile?.favoriteArtists ?? []),
  ];
  if (pool.length === 0) return [];
  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000);
  const picks: string[] = [];
  for (let i = 0; i < count && i < pool.length; i++) {
    picks.push(pool[(dayOfYear + i) % pool.length]!);
  }
  return picks;
}

async function callDailyBriefViaClaude(input: string, userName: string): Promise<string | null> {
  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 4000,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages:   [{ role: "user", content: input }],
    });

    const searchCount = resp.content.filter((b) => b.type === "server_tool_use").length;
    logger.info({ userName, searchCount }, "[DailyBrief] Search call count for this run");

    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();

    if (!text) {
      logger.warn({ userName }, "[DailyBrief] Empty text from Claude");
      return null;
    }
    return sanitizeBriefText(text);
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] Claude call failed");
    return null;
  }
}

export async function generateDailyBrief(userName: string): Promise<string | null> {
  try {
    const [contextBlock, interestPicks] = await Promise.all([
      buildDailyBriefContext(userName),
      getDailyInterestPicks(userName),
    ]);

    const input = `${buildDailyBriefInstruction(interestPicks)}\n\n${contextBlock}`;

    let text = await callDailyBriefViaClaude(input, userName);
    if (!text) {
      // One retry on outright failure (network/API error, empty response) —
      // not a "too few searches" signal like the old OpenAI path needed.
      // Claude's web_search tool reliably performs the real per-topic
      // searches this instruction asks for; verified directly against
      // OpenAI's web_search_preview tool, which does not.
      logger.warn({ userName }, "[DailyBrief] First attempt failed — retrying once");
      text = await callDailyBriefViaClaude(input, userName);
    }

    return text;
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
        input: `${contextBlock}\n\n${buildDailyBriefInstruction([])}`,
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
          { role: "user", content: `${contextBlock}\n\n${buildDailyBriefInstruction([])}` },
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

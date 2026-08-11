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
import { getRecentBriefingTexts, saveBriefingText } from "./briefingCache.js";
import { fetchTodayEvents } from "../google/calendar.js";
import { query } from "../db.js";

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

function buildDailyBriefInstruction(interestPicks: string[], includeMarkets: boolean): string {
  const interestSearchBlock = interestPicks.length > 0
    ? `\n\nSEARCH 1b — Personal interest news: search specifically for recent news connected to: ${interestPicks.join(", ")}. This is in addition to Search 1a, not instead of it — the goal is to surface something genuinely newsworthy tied to what this person actually cares about. If nothing real turns up, that's fine — don't force it.`
    : "";

  return `You are about to write a Morning Run Down. Before writing anything, perform the searches below as separate, well-formed queries, one topic at a time — do not combine them into one query, and do not search using the biographical context block that follows this instruction (that block is background for personalizing the writing later, not a search query).

SEARCH 1a — National news: search for today's top US and world news headlines. Aim for 5 real stories worth knowing — major national and international stories only. Do not include hyper-local news from a single city or small region — local government votes, local development projects, local tribal/community news. Exclude stock market and business-finance stories here — that's covered separately in Search 3 — and exclude AI industry/tech company news (product launches, funding rounds, model releases) unless it's genuinely historic.${interestSearchBlock}

STORY QUALITY BAR — applies to every item in Search 1a and 1b alike: only include a story if your search results let you state who/what/when clearly and specifically. If the results are thin, contradictory, or leave the basic facts unclear (you can't say what actually happened or to whom), drop it and use a different story instead — an incoherent story is worse than one fewer story. Also exclude recurring event announcements and PR/marketing-style items with no real news hook — "X festival returns this year," "Nth-annual Y classic announced," a venue's routine seasonal promotion — these aren't news even when they technically connect to one of this person's interests; an interest-tied search should surface an actual event, development, or story involving that interest, not a calendar listing.

When choosing the final list of stories, prefer genuinely important news, but when two stories are similarly newsworthy, favor the one connected to this person's actual interests over an equally routine but disconnected one. If Search 1b turned up something real and relevant, fold it into the same numbered list rather than giving it a separate section.

SEARCH 2 — Sports: search for this person's teams' most recent completed games (the specific team names are in the context block below — use them as the search terms, e.g. "[team name] score last night"). Report only FINAL scores from the most recently completed game per team — last night's game if one was played, otherwise their most recent prior game. Verify the date the game was actually played from your search results before including it — if you cannot confirm it was last night's game (or, absent one, the single most recent prior game), leave that team out of the sports section rather than reporting an older score.

${includeMarkets
  ? `SEARCH 3 — Markets: search for stock futures and overnight financial news ahead of today's open (e.g. "stock futures today", "Dow S&P Nasdaq futures").`
  : `SEARCH 3 — Markets: skip this search entirely — it's the weekend and US markets are closed, so there's nothing to report ahead of an open that isn't happening today.`}

SEARCH 4 — Weird/funny story: search UPI's Odd News desk first — try "site:upi.com Odd News" or "UPI odd news today" — that's the primary source. If that doesn't turn up something genuinely funny or delightfully absurd, fall back to AP's Oddities coverage — try "site:apnews.com oddities" or "AP oddities today". These outlets have real editors selecting for exactly this quality — genuinely funny or delightfully absurd, not just odd — which is the actual bar, not merely "unusual." A real story with a specific person or place and an unexpected twist — something a person could mention at lunch and get a genuine reaction. If nothing from either source clears that bar, that's fine — see the WEIRD/FUNNY STORY formatting rule below on when to skip it.

Weather and the joke of the day are NOT things to search for — verified current weather conditions and a real pool of joke candidates are already provided in the context block below. Use that data as-is; do not search for weather (do not guess, and do not include a multi-day forecast), and do not search for or invent a joke — pick one from the candidates given.

This briefing is delivered in the early morning, before the stock market opens for the day. Sports scores should always be from yesterday's/last night's completed games — never describe a game as happening "today" unless you've confirmed via search that it already occurred earlier the same calendar day in this person's timezone. Never give a live/current stock quote or price snapshot — the market is closed at this hour and a snapshot price is meaningless.

After completing all searches above, write a genuinely enjoyable Morning Run Down covering: the weather from the context block, the to-dos and calendar events from the context block, the news from Search 1, the markets info from Search 3, the sports scores from Search 2, the story from Search 4, and a joke picked from the verified candidates in the context block. Use only real, current, verified information from your searches (and the verified weather/to-dos/calendar data) — never invent facts, venues, dates, scores, or weather. EVERY section — including Weather — gets its own header (an emoji plus a short title, one line, on its own); vary the emoji and phrasing day to day, but never fold a section into the opening greeting or another section instead of giving it a header. Beyond that, style is your call — vary the wording and exact phrasing day to day rather than repeating an identical script every time. Overall length should come from covering enough distinct topics, not from writing at length about any single one of them.

WEATHER: Give this section its own header, separate from the opening greeting (the greeting itself should just be a short "good morning" line, nothing else). One or two sentences using only the verified weather data from the context block — conditions, temperature, high/low. Never guess, never add a multi-day forecast.

YOUR DAY: Give this section its own header. List the VERIFIED TO-DOS and VERIFIED CALENDAR EVENTS from the context block, plainly — a to-do per line, a calendar event per line (time plus what it is). No commentary, no editorializing, no "looks like a busy day" framing, no advice — just the items themselves, verbatim from what's given, nothing added and nothing invented. If both lists are empty ("None."), skip this section entirely rather than writing "nothing on your plate today" or similar filler.

NEWS ITEM LENGTH — HARD LIMIT: Each of the 5 news items gets a headline plus exactly ONE sentence underneath it — no exceptions, this is a hard cap, not a target to aim for. That one sentence is a single grammatical sentence ending in one period — not two clauses stitched together with a semicolon or "and," not a sentence followed by a second one on the next line. Before moving to the next item, check what you wrote: if there are two periods (other than one at the very end) or two separate lines of body text, you have written too much — cut it down to one sentence and move on. This is the single most important formatting rule in this entire prompt.

NEUTRALITY — CRITICAL: Report only the concrete fact of what happened (who, what, when) — never characterize it, never editorialize, never take a side or imply one is right, never speculate on motives or consequences, never use loaded or opinionated language. This applies to every item, political or not, and applies even when the search results themselves are framed with opinion or analysis — strip that out and report just the underlying fact. Specifically banned: reaction/framing sentences or clauses tacked onto the fact, like "a serious escalation," "not a new headline, but...," "worth flagging," "tough one," "wine country in crisis," or any other editorial aside — if you catch yourself writing one, delete it rather than keep it as a second sentence. The one sentence you keep is always the fact itself, never your reaction to the fact.

SPORTS: State the result unambiguously, spelling out who won — e.g. "[Team] beat [Opponent], 5–2" or "[Team] lost to [Opponent], 2–5" — always this-person's-team's-score first, opponent's second, and always paired with "beat"/"lost to" so the order can never be misread as reversed. Never just list "team, score, opponent" without saying who won. Do not mention upcoming games, schedules, or say a team is "set to play today" — this section covers only what already happened, never what's coming up.

MARKETS & INVESTING — HARD LIMIT: ${includeMarkets
  ? `Two or three sentences, total, no more. Futures direction for the major indices (Dow, S&P, Nasdaq), plus the ONE or TWO biggest overnight drivers (an earnings report, Fed commentary, a major economic data release, a geopolitical development) — not a survey of everything moving markets today. This section should read as a quick heads-up, not a market column; it must never come out longer than the news section combined. Frame it as what the trading day ahead holds, not a snapshot of where things stood at some overnight timestamp — don't reference a specific time or timezone for any price or figure.`
  : `It's the weekend — US markets are closed, so skip the search and keep this section to exactly one line: "Markets are closed for the weekend." Nothing else — no recap of Friday's close, no preview of Monday.`}

WEIRD/FUNNY STORY: From Search 4's results, pick the single most genuinely funny or delightfully absurd story you found — something a person could mention at lunch and get a real reaction, not just "huh, weird." Skip anything that's political, crime-related, cruel, sad, or just a routine "odd but not funny" wire-service item with no real twist — most generic search results will be exactly that, which is why Search 4 points you at outlets that actually curate for this quality specifically. Use only real facts from what you found — never invent specific details to make a story land better. If nothing from Search 4 genuinely clears this bar, skip this section entirely rather than settling for a weak one — a missing story is better than a boring one.

JOKE OF THE DAY: The context block gives you a real pool of joke candidates (VERIFIED JOKE CANDIDATES) — pick exactly ONE to deliver, the single funniest and most genuinely tellable one in the whole list. This is a judgment call, and it matters: think about what someone who's actually good at telling jokes would tell a friend, not what a dad-jokes calendar would print. Skip — do not pick — anything that's just a pun or wordplay for its own sake ("...because he's a fungi," "algae-bra," anything where the punchline is a play on words rather than a real idea or twist), and skip generic "why did the X cross the Y" riddle-format jokes too. Favor candidates with a genuine idea, an ironic turn, an observation, or a story — the kind of joke that gets a real laugh, not a groan. A good pick can be one line or several; length isn't the criterion, wit is. Give the one you pick straight — don't explain why it's funny, don't apologize for it, don't over-introduce it, just tell it. If NONE of the candidates are genuinely good by this bar, skip this section entirely rather than settling for a weak one — a missing joke is better than a bad one.

FORMATTING — CRITICAL: Write in clean, plain, readable prose only — this will be read aloud via text-to-speech, so it must sound natural when spoken. Never include citation brackets, markdown links, raw URLs, "utm_source" parameters, "#:~:text=" fragment identifiers, or any link syntax anywhere in the output. When you want to credit a source, say it in plain spoken words woven into the sentence — e.g. "according to the AP" or "Axios reports" — never as a clickable link or bracketed reference. Do NOT include a "Sources:" section, footer, bibliography, or list of links anywhere, including at the end. The entire output must read as clean spoken prose from start to finish with zero raw URLs or citation markup of any kind.

Do not include ANY meta-commentary, narration, or explanation of your own process or reasoning anywhere in the output, in any form — this is the single most important rule in this prompt, and it covers more than just a leading sentence. Banned, no matter where in the output it appears: narrating what you're about to do or just did ("Now I have everything I need," "Let me search for...", "Here is the briefing:"); explaining or justifying an editorial choice you made — which story you picked and why, which weird/funny story you rejected and why (e.g. "the wing-walker story was already used yesterday," "the raccoon story is too local"), why a section is missing, why a game hasn't happened yet, why no joke was available; addressing the reader/operator directly about the process ("let me know if you have questions," "here's my reasoning"). None of that belongs in the output under any circumstances — if a section has nothing to say, it simply doesn't appear, with zero explanation of why. The very first character of your output must be the start of the actual greeting — not a sentence about you, your process, or your reasoning — and the very last character must be the end of the My Life line described below, nothing appended after it.

THE MORNING STOIC: Give this section the header "🧘 The Morning Stoic" (keep this exact header — the one part of the output that does NOT vary day to day). Go straight from the header into today's Stoic quote from the context block, delivered essentially as given — the exact words, attributed naturally (e.g. "As Marcus Aurelius wrote..." or "Epictetus wrote..."). Do not add any framing or lead-in sentence before the quote — no scene-setting, no "there is something to be said for..." — the header leads directly into the quote itself. Immediately after the quote, in exactly ONE sentence, say what it actually means today in genuinely plain, ordinary English — the way you'd explain it to a friend over coffee. Do NOT reach for any specific metaphor domain — not technology, not engineering, not sports, not cooking. No "processor," "RAM," "system," "framework," "install," "run," or any other word that belongs to computers or machinery. No philosophy jargon, no "the Stoics believed," no lecturing. Vary the wording of this one sentence day to day. Close the section — and the entire briefing — with exactly this line, unchanged every day: "Go to My Life to record any thoughts." Nothing after it.

For loose style reference only (not a required template), here is a briefing this person said they liked:

(This example is showing you TONE AND STRUCTURE ONLY. Every fact, story, quote, and detail in your actual output must come from your own fresh search results for today (or, for the joke, from the verified candidates given, and for weather/to-dos/calendar, from the verified context data). Do not reuse, paraphrase, or reproduce ANY specific fact, story, or detail from this example under any circumstances. If your search doesn't turn up a good weird/funny story, or none of the joke candidates are genuinely good, skip that section entirely rather than reusing the example. Any place names, cities, venues, team opponents, scores, jokes, to-dos, or events shown in brackets below are placeholders — never use a real one from this example in your actual output.)

[EXAMPLE 1]
☕ David's Daily Brief
Friday, July 17, 2026
Good morning!

🌤️ Weather
Dallas is starting clear at [temp]°F, feeling like [temp]°F, with a high of [temp]°F expected — [chance]% chance of rain.

📋 Your Day
- [to-do text, verbatim from the context block]
- [to-do text, verbatim from the context block]
- 10:30 AM: [calendar event summary]

🌎 The 5 Stories That Matter
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
[a real, current lighthearted news story — something genuinely funny or delightfully absurd from Search 4, not invented]

😄 Joke of the Day
[the single funniest, genuinely tellable joke picked from the verified candidates — not a pun, not a riddle, delivered straight, no explanation]

🧘 The Morning Stoic
"The important thing is not to stop questioning." — Albert Einstein
[one plain-language sentence on what it actually means today, modern and wry, not lecturing]
Go to My Life to record any thoughts.`;
}

// Strips a leading self-narration preamble Claude sometimes emits despite
// the prompt's explicit "no meta-commentary, begin directly with the
// greeting" instruction. Observed live in several phrasings, including a
// full editorial-reasoning paragraph ("I now have everything I need. The
// UPI odd news page turned up the bear-in-the-pool story... Here is the
// briefing:") that the original narrower start-of-string regex didn't
// catch — "I now have" wasn't covered (only "now I have"), and the
// paragraph explaining story/joke selection reasoning had no pattern at
// all. Two independent strategies, tried in order:
//
// 1. A "hand-off" phrase like "here is/here's the briefing:" is a strong,
//    unambiguous signal on its own — the real briefing would never refer to
//    itself as "the briefing" — so if found anywhere before the real
//    content, everything up to and including it is cut, regardless of how
//    the preamble before it was phrased.
// 2. Otherwise, fall back to matching known leak-start phrasings at the very
//    start of the text and cutting through the next blank line.
//
// Does nothing if neither matches, so it can't eat legitimate content.
function stripMetaPreamble(text: string): string {
  const handoff = /here'?s?\s+(?:is\s+)?the briefing:?/i;
  const handoffMatch = handoff.exec(text);
  if (handoffMatch) {
    return text.slice(handoffMatch.index + handoffMatch[0].length).trimStart();
  }

  const leakStart = /^\s*(?:now i have|i now have|good[\s—-]+i(?:'ve| have| now have)|i(?:'ve| have) (?:got|gathered|found) everything|here'?s what i (?:found|have|gathered)|let me (?:write|put together|pull this together))\b/i;
  if (!leakStart.test(text)) return text;
  const blankLineIdx = text.search(/\n\s*\n/);
  return blankLineIdx === -1 ? text : text.slice(blankLineIdx).trimStart();
}

// Server-side safety net — the prompt's anti-link/citation/meta-commentary
// instructions are demonstrably not followed reliably (observed citation/URL
// and self-narration leakage despite explicit instructions against both).
// Backstop, not a replacement for the prompt.
function sanitizeBriefText(text: string): string {
  return stripMetaPreamble(text)
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

// Turns the prompt's fixed closing line into a real tappable link — done in
// code rather than asked of the model, so it's always exactly right instead
// of depending on the model reproducing link syntax correctly (and so
// sanitizeBriefText's markdown-link-stripping safety net, which runs before
// this, doesn't eat it — this must run AFTER sanitizeBriefText). The deep
// link is handled client-side in app/_layout.tsx alongside the existing
// winstonnative://chat / winstonnative://auth handlers, and
// normalizeTtsText (lib/ttsNormalize.ts) strips the markdown syntax back out
// before speech so it's spoken as plain "My Life", not read-aloud brackets.
// If the model didn't reproduce the line exactly, this simply doesn't match
// and the plain text stands — no error, just no link that day.
function injectMyLifeLink(text: string): string {
  return text.replace(
    /Go to My Life to record any thoughts\.?/,
    "Go to [My Life](winstonnative://mylife) to record any thoughts."
  );
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

// ── Joke of the day — a real source, not a web search ────────────────────────
// API Ninjas' /v1/jokeoftheday returns exactly one fixed joke per day (no
// category/blacklist filtering, unlike the old JokeAPI source) — so the
// candidate pool here is a single item. The judgment call is still left to
// Claude: the main instruction below already tells it to skip the joke
// section entirely if the one candidate isn't genuinely good (not a pun,
// not a riddle), which still holds with a pool of one.
async function fetchJokeCandidates(): Promise<string[]> {
  const apiKey = (process.env.API_NINJAS_KEY ?? "").trim();
  if (!apiKey) {
    logger.warn("[DailyBrief] API_NINJAS_KEY not set — skipping joke of the day");
    return [];
  }
  try {
    const res = await fetch(
      "https://api.api-ninjas.com/v1/jokeoftheday",
      { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const data = await res.json() as Array<{ joke?: string }>;
    return data
      .map((j) => j.joke ?? null)
      .filter((t): t is string => !!t?.trim());
  } catch {
    return [];
  }
}

// ── Your Day — plain to-dos, verified from the database ──────────────────────
// Open-ended to-dos (no fire_at) plus anything specifically scheduled for
// today — a reminder timed for 3pm today belongs in "your day" just as much
// as an undated to-do does. No LLM involvement: this is rendered plainly by
// Claude straight from what's fetched here, same pattern as weather/jokes.
async function fetchTodayTodos(userName: string, tz: string): Promise<string[]> {
  try {
    const { rows } = await query<{ reminder_text: string }>(
      `SELECT reminder_text FROM reminders
        WHERE user_name = $1
          AND status = 'pending'
          AND (fire_at IS NULL OR (fire_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)
        ORDER BY fire_at ASC NULLS LAST, created_at ASC`,
      [userName, tz]
    );
    return rows.map((r) => r.reminder_text);
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] fetchTodayTodos failed");
    return [];
  }
}

// ── Context-gathering for generateDailyBrief ──────────────────────────────────
async function buildDailyBriefContext(userName: string): Promise<{ block: string; includeMarkets: boolean }> {
  const [profile, goals, profileItems, memories, stoic, jokeCandidates, recentBriefings] = await Promise.all([
    getProfile(userName).catch(() => null),
    getGoals(userName).catch((): Awaited<ReturnType<typeof getGoals>> => []),
    getProfileItems(undefined, userName).catch((): Awaited<ReturnType<typeof getProfileItems>> => []),
    getRecentMemories(7).catch(() => []),
    getStoicForUser(userName).catch(() => null),
    fetchJokeCandidates(),
    getRecentBriefingTexts(userName, 2).catch(() => []),
  ]);

  const name = profile?.name ?? userName;
  const locationContext = await getUserLocationContext(userName).catch(() => null);
  const city = locationContext?.city ?? profile?.city ?? "an unknown city";
  const tz = locationContext?.timezone ?? profile?.timezone ?? "UTC";

  const [todosToday, calendarEventsToday] = await Promise.all([
    fetchTodayTodos(userName, tz),
    fetchTodayEvents(userName).catch((err) => {
      logger.warn({ err, userName }, "[DailyBrief] fetchTodayEvents failed");
      return null;
    }),
  ]);
  const todosBlock = todosToday.length > 0
    ? todosToday.map((t) => `- ${t}`).join("\n")
    : "None.";
  const calendarBlock = calendarEventsToday === null
    ? "Calendar not connected."
    : calendarEventsToday.length > 0
      ? calendarEventsToday.map((e) => `- ${e.allDay ? "All day" : e.start}: ${e.summary}`).join("\n")
      : "None.";

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

  const jokeCandidatesBlock = jokeCandidates.length > 0
    ? jokeCandidates.map((j, i) => `${i + 1}. ${j}`).join("\n")
    : "None available today — skip the joke of the day section entirely rather than inventing one or searching for one.";

  const recentBriefingsBlock = recentBriefings.length > 0
    ? recentBriefings.map((t, i) => `[Briefing from ${i === 0 ? "yesterday" : i + 1 + " days ago"}]\n${t}`).join("\n\n")
    : "None on file — this is either the first briefing or none were saved recently.";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const localWeekday = new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const includeMarkets = localWeekday !== "Sat" && localWeekday !== "Sun";

  const block =
`Today's date: ${today}
Name: ${name}
City: ${city}
VERIFIED WEATHER DATA for ${city} (use exactly this — do not search for or guess weather): ${weatherLine}
VERIFIED TO-DOS for today (use exactly this list — do not search for, invent, or add to it):
${todosBlock}
VERIFIED CALENDAR EVENTS for today (use exactly this list — do not search for, invent, or add to it):
${calendarBlock}
Interests: ${interestsLine}
Active goals: ${goalsLine}
${profileItemsBlock}
Recent context: ${memoriesBlock || "no recent conversation memories"}
Today's reflection: ${stoicLine}
VERIFIED JOKE CANDIDATES (real jokes from a dedicated source — pick exactly ONE to deliver, do not invent your own, do not search for one):
${jokeCandidatesBlock}
RECENT BRIEFINGS (for avoiding repeats only — never read this back or reference it directly): the weird/funny story, the joke, and the news angles below were already delivered recently. Today's actual news will naturally differ since real events happened since then, but do not pick the same weird/funny story, the same joke, or lean on the same angle for an interest-tied story again — if your search for a fresh weird/funny story doesn't turn up something different from what's shown here, skip that section rather than repeat it.
${recentBriefingsBlock}`;

  return { block, includeMarkets };
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

    // web_search is a server-side tool — a single response interleaves
    // "text" blocks with server_tool_use/web_search_tool_result blocks as
    // Claude narrates between searches ("Let me check today's headlines...",
    // "Now checking scores..."). Joining every text block (the old
    // behavior) prepended that narration straight onto the real content.
    // The real final answer isn't one single text block either — confirmed
    // live that citation-bearing text comes back fragmented into many text
    // blocks (split mid-sentence at each citation boundary), all appearing
    // AFTER the last tool-use/tool-result block and never followed by
    // another one. Narration blocks only ever appear BEFORE a subsequent
    // tool call. So: find the last tool-related block, keep only the text
    // blocks after it, and join those with no separator (they're literal
    // mid-sentence continuations of one another, not separate paragraphs).
    let lastToolIdx = -1;
    resp.content.forEach((b, i) => {
      if (b.type === "server_tool_use" || b.type === "web_search_tool_result") lastToolIdx = i;
    });
    const text = resp.content
      .slice(lastToolIdx + 1)
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    if (!text) {
      logger.warn({ userName }, "[DailyBrief] Empty text from Claude");
      return null;
    }
    return injectMyLifeLink(sanitizeBriefText(text));
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] Claude call failed");
    return null;
  }
}

// In-flight de-dup — generateDailyBrief has no cache of its own (removed
// along with the old scheduled pre-generation pipeline), so two overlapping
// calls for the same user each run a full independent Sonnet + web_search
// generation, producing two genuinely different briefings (different top
// stories, different joke) shown back to back. Confirmed live: this is
// reachable from a single user action — the morning-push notification's
// trigger message has no client-side "generating…" feedback, so a user who
// doesn't see anything happen yet can easily end up sending the trigger a
// second time before the first call has returned. Same in-flight-promise
// pattern as ticketmasterEventsManager.ts's _fetchInFlight.
const _inFlight = new Map<string, Promise<string | null>>();

export async function generateDailyBrief(userName: string): Promise<string | null> {
  const existing = _inFlight.get(userName);
  if (existing) {
    logger.info({ userName }, "[DailyBrief] Generation already in flight — reusing it instead of starting a second one");
    return existing;
  }

  const promise = generateDailyBriefOnce(userName).finally(() => {
    _inFlight.delete(userName);
  });
  _inFlight.set(userName, promise);
  return promise;
}

async function generateDailyBriefOnce(userName: string): Promise<string | null> {
  try {
    const [{ block: contextBlock, includeMarkets }, interestPicks] = await Promise.all([
      buildDailyBriefContext(userName),
      getDailyInterestPicks(userName),
    ]);

    const input = `${buildDailyBriefInstruction(interestPicks, includeMarkets)}\n\n${contextBlock}`;

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

    if (text) {
      saveBriefingText(userName, text).catch((err) =>
        logger.warn({ err, userName }, "[DailyBrief] Failed to save briefing text for repeat-avoidance")
      );
    }

    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] generateDailyBrief failed");
    return null;
  }
}


import Anthropic from "@anthropic-ai/sdk";
import { type CalendarEvent, fetchTodayEvents } from "../google/calendar.js";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { fetchMorningNews } from "../news/newsManager.js";
import { getProfileItems, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext, type PersonEntry } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { fetchSportsScores, formatSportsForPrompt } from "../sports/sportsManager.js";
import { setStaticBriefingContext, setCachedBriefing } from "./briefingCache.js";
import { getSeenHeadlines, extractBoldHeadlines, filterNewsBlock } from "./storyDedup.js";
import { logger } from "../lib/logger.js";
import { getBriefingPreferences, buildBriefingPrefsBlock } from "../briefingPreferences/briefingPreferencesManager.js";
import { getOrdersForBriefing } from "../orders/ordersManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import { query } from "../db.js";
import { getUserSettings, getStoicForUser, incrementStoicDay, buildStoicBlock, isStoicQuoteAccessible, getAlternativeStoicQuote, type UserSettings } from "../stoic/stoicManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { getGoals } from "../goals/goalsManager.js";

// Dallas local content is now handled by dallasContent.ts (RSS feeds + web search fallback).
// Imported below alongside other module imports.

function buildBaseSystemPrompt(userName?: string | null): string {
  const user = userName ?? "you";
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/__USER__/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are a knowledgeable, genuinely helpful AI companion for __USER__. Be accurate, direct, and useful. Keep responses concise — typically 2–4 sentences unless __USER__ clearly wants more. Never start a response with "I" as the first word.

GUIDING PRINCIPLE:
Be bold and specific. When you know something — say it directly. Draw connections naturally and confidently. The only hard constraints: never fabricate facts, never share user data.

VERIFIED DATA — state as fact, directly. No softening, no hedging:
• Calendar: reproduce event titles letter-for-letter exactly as they appear. Never add names or context not explicitly in the title.
• News, sports, weather, stocks: state from [VERIFIED] blocks as fact. Never invent headlines, scores, or statistics.
• Never reference block names in your spoken output — just state the facts naturally.

When __USER__ asks about something not in a verified block, say so in one sentence and keep moving.

`;

function getCurrentDateTimeBlock(tz: string): string {
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthName = now.toLocaleDateString("en-US", { timeZone: tz, month: "long" });
  const day = now.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const time = now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
  const localHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
  const partOfDay = localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";

  const ctDate = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const dow = ctDate.getDay(); // 0=Sun, 1=Mon...6=Sat
  const isWeekend = dow === 0 || dow === 6;

  // Yesterday's day name
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const yesterdayName = DAYS[(dow + 6) % 7];

  // Tomorrow's name
  const tomorrowName = DAYS[(dow + 1) % 7];

  return (
    `[Current date and time — injected fresh on every briefing]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} Central Time (${partOfDay}).\n` +
    `Day type: ${isWeekend ? "weekend" : "weekday"}.\n` +
    `Yesterday was ${yesterdayName}. Tomorrow is ${tomorrowName}.\n` +
    `Use ONLY these values when referring to days. "Yesterday" means ${yesterdayName}. "Tomorrow" means ${tomorrowName}.\n` +
    `When asked what time or day it is, answer directly using exactly the values above.\n`
  );
}

function buildPeopleContextBlock(people: PersonEntry[], displayName?: string): string {
  if (people.length === 0) return "";

  const partnerRels = ["girlfriend", "boyfriend", "wife", "husband", "partner", "fiancée", "fiancé"];
  const lines: string[] = [];

  for (const p of people) {
    const name = (p.name ?? "").trim();
    const rel = (p.relationship ?? "").trim();
    if (!name || !rel) continue;

    const address = p.address?.trim();
    const birthday = p.birthday?.trim();
    const notes = p.notes?.trim();
    const anniversary = p.anniversary?.trim();
    const isPartner = partnerRels.some((r) => rel.toLowerCase().includes(r));

    const parts: string[] = [`${name} — ${rel}${isPartner ? " (Your Partner)" : ""}`];
    if (address) parts.push(`${address}`);
    if (birthday) parts.push(`birthday: ${birthday}`);
    if (anniversary) parts.push(`${displayName?.split(" ")[0] ?? "your"} & ${name.split(" ")[0]} anniversary: ${anniversary}`);
    if (notes) parts.push(notes);

    lines.push(`• ${parts.join(", ")}`);
  }

  if (lines.length === 0) return "";

  return (
    `\n\n[Key People — Reference naturally in the briefing]\n` +
    lines.join("\n") + "\n\n" +
    `HOW TO USE THIS:\n` +
    `• Susan (Your Partner) — include a warm, specific one-liner in the Section 15 closing every briefing. Examples: "Hope you and Susan have a great night", "Give Susan my best." Keep it natural — not every closing needs to be about her, but include her often.\n` +
    `• Birthdays — if any birthday is within 7 days, surface it in Section 13 with the date. If it's today, make it feel special.\n` +
    `• Never invent details not listed here. Base any reference on the facts in this block.`
  );
}

function buildNarrativeBriefingInstruction(
  city: string,
  companionName: string | null,
  displayName?: string,
  settings?: { briefingStoic?: boolean; briefingWeather?: boolean; briefingCalendar?: boolean; briefingNews?: boolean }
): string {
  const name = displayName ?? "the user";
  const companion = companionName ?? "Winston";

  return `

[MORNING RUN DOWN — DELIVERY INSTRUCTIONS]

You are ${companion}, delivering ${name}'s Morning Run Down. This is a spoken briefing — natural, warm, direct. Under 90 seconds total. No bullet points. No headers. Flowing conversational prose only.

Work through each section below IN ORDER. Skip any section where no data is present in your context.

${settings?.briefingWeather !== false ? `
SECTION 1 — WEATHER
One sentence only. Current conditions and today's high. Flag any severe weather.
Do NOT mention tomorrow. Do NOT give rain percentages unless rain is likely.
` : ""}

${settings?.briefingCalendar !== false ? `
SECTION 2 — THE DAY AHEAD
Only if calendar data is present. State each event plainly: time, then what it is. No commentary, no framing, no editorializing about how the day looks.
GOOD: "You have two things today: at 1pm, take the dog to the vet. At 4pm, meet for drinks."
BAD: "You've got a pretty light day today, just a couple of things on the calendar."
If the calendar is clear, say so in one plain sentence and move on — do not say "blank slate" or similar.
No departure times. No tomorrow. No "later this week".
` : ""}

SECTION 3 — TO-DOS & REMINDERS
Only if to-do or reminder data is present. Read them out plainly.
Timed reminders first, then open to-dos. No commentary, just the items.
Example: "You have a reminder at 2pm to call the dentist, and a couple of open to-dos — pick up the dry cleaning, get gas."

SECTION 4 — ORDERS
Only if order data is present. One sentence per order arriving today.
Example: "You have a package from Amazon arriving today."

${settings?.briefingNews !== false ? `
SECTION 5 — WHAT'S MAKING NEWS
Deliver as Walter Cronkite — just the facts, no commentary, no opinion, no framing.
4 to 5 headlines maximum. Each headline is one sentence. Lead with: "Here's what broke overnight:"
If a feel-good or surprising story is present in the news block, deliver it last as a natural closer before sports.
` : ""}

SECTION 6 — SPORTS
Only if sports data is present for the user's teams. Scores only.
Example: "Cowboys beat the Lions 45 to 13. Rangers lost to Houston 3 to 2."
If no sports data, skip entirely.

SECTION 7 — THE STOIC CLOSE
Follow the STOIC CLOSE DELIVERY INSTRUCTIONS in the verified block exactly.

TONE THROUGHOUT:
Warm but not effusive. Direct but not cold. Like a trusted friend who has done their homework and respects your time.
Open with a brief, warm greeting using ${name}'s name — vary the phrasing naturally across days (e.g. "Good morning, ${name}", "Rise and shine, ${name}", "Top of the morning, ${name}"). One line only, no filler like "Great!" or "Wonderful!" before it. Then move into the first available section.
Never end with "Have a great day" or any generic sign-off. The Stoic close is the ending.
`;
}

// In-flight dedup for preFetchMorningBriefing — prevents multiple concurrent
// pre-gen calls (from startup + cron tick + sendMorningPush fallback) from each
// spawning their own set of Apify actor runs. All concurrent callers for the
// same user share the single in-flight promise.
const _prefetchInFlight = new Map<string, Promise<void>>();

export async function preFetchMorningBriefing(userName: string): Promise<void> {
  const existing = _prefetchInFlight.get(userName);
  if (existing) {
    logger.info({ userName }, "[Briefing] preFetchMorningBriefing already in flight — deduplicating concurrent call");
    return existing;
  }

  const promise = _doBriefingPrefetch(userName).finally(() => { _prefetchInFlight.delete(userName); });
  _prefetchInFlight.set(userName, promise);
  return promise;
}

// ── Onboarding nudge helpers — once per day if profile not yet complete ───────
async function shouldShowOnboardingNudge(userName: string, tz: string): Promise<boolean> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const result = await query<{ last_mention_date: string }>(
      `SELECT last_mention_date::text AS last_mention_date FROM onboarding_nudge_log WHERE user_name = $1`,
      [userName]
    );
    if (result.rows.length === 0) return true;
    return result.rows[0].last_mention_date !== today;
  } catch {
    return false;
  }
}

async function markOnboardingNudgeShown(userName: string, tz: string): Promise<void> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    await query(
      `INSERT INTO onboarding_nudge_log (user_name, last_mention_date)
       VALUES ($1, $2)
       ON CONFLICT (user_name) DO UPDATE SET last_mention_date = $2`,
      [userName, today]
    );
  } catch { /* non-fatal */ }
}

async function _doBriefingPrefetch(userName: string): Promise<void> {
  const { timezone, city: locationCity, lat: locationLat, lon: locationLon } = await getUserLocationContext(userName);
  const generationDateKey = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  logger.info({ userName, generationDateKey }, "Pre-generating morning briefing");
  try {
    const [recentMemories, allProfileItems, userProfile, keyPeople, seenHeadlines, briefingPrefs, userSettings] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
      getPeople(userName).catch(() => [] as PersonEntry[]),
      getSeenHeadlines(userName, 3).catch(() => new Set<string>()),
      getBriefingPreferences(userName).catch(() => []),
      getUserSettings(userName).catch(() => null as UserSettings | null),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile)
        : buildBaseSystemPrompt(userProfile?.name);

    // ── Onboarding nudge — inject once per day if profile not yet complete ────
    let onboardingNudgeBlock = "";
    if (userProfile && !userProfile.onboardingCompleted) {
      const nudgeShouldShow = await shouldShowOnboardingNudge(userName, timezone);
      if (nudgeShouldShow) {
        await markOnboardingNudgeShown(userName, timezone);
        onboardingNudgeBlock =
          `\n\n[Onboarding Reminder — Weave in naturally near the end of briefing]\n` +
          `This user has not yet completed their profile setup. Near the end of the briefing, ` +
          `after the main content, include this as a casual friendly aside — not an announcement:\n` +
          `"By the way, I notice we haven't finished getting me fully set up yet. Would you like ` +
          `to schedule some time today to complete your profile so I can do a better job for you?"\n` +
          `Keep it warm and brief — one sentence. Do NOT lecture or repeat it. If the user responds yes, help them pick a time and create a reminder.`;
        logger.info({ userName }, "[Briefing] Onboarding nudge injected into today's briefing");
      }
    }

    const primaryCity = (userProfile?.city?.trim() ?? locationCity ?? "").trim();
    const primaryLat = userProfile?.latitude ?? locationLat ?? null;
    const primaryLon = userProfile?.longitude ?? locationLon ?? null;

    const [newsBlock, sportsScores, outForDeliveryOrders, todayEvents] = await Promise.all([
      fetchMorningNews(userName).catch(() => ""),
      fetchSportsScores(userName).catch(() => null),
      getOrdersForBriefing(userName).catch(() => []),
      fetchTodayEvents(userName).catch(() => null),
    ]);

    const todayReminders = await query<{ reminder_text: string; fire_at: string | null }>(
      `SELECT reminder_text, fire_at FROM reminders
       WHERE user_name = $1
         AND status = 'pending'
         AND (fire_at IS NULL OR fire_at::date = CURRENT_DATE)
       ORDER BY fire_at ASC NULLS LAST
       LIMIT 10`,
      [userName]
    ).then(r => r.rows).catch(() => []);

    // ── Weather context (fetched at pre-gen time) ─────────────────────────────
    const weatherData = await getCachedWeather(primaryCity, primaryLat, primaryLon, timezone).catch(() => null);

    const weatherContextBlock = weatherData
      ? `\n\n[VERIFIED — Weather — ${primaryCity}]\n` +
        `Right now: ${weatherData.temp}°F (feels like ${weatherData.feelsLike}°F), ${weatherData.condition}\n` +
        `Today: high ${weatherData.high}°F / low ${weatherData.low}°F` +
        (weatherData.precipChance > 20 ? `, ${weatherData.precipChance}% chance of rain` : "") + `\n`
      : "";

    // ── Story dedup — filter seen headlines ──────────────────────────────────
    const { filtered: dedupedNewsBlock, removed: removedNewsHeadlines } = filterNewsBlock(newsBlock, seenHeadlines);
    if (removedNewsHeadlines.length > 0) {
      logger.info({ userName, removed: removedNewsHeadlines }, "[StoryDedup] Filtered duplicate news headlines");
    }

    const candidateStoryKeys: string[] = extractBoldHeadlines(newsBlock);

    const sportsBlock = sportsScores ? formatSportsForPrompt(sportsScores) : "";

    const ordersBlock = (() => {
      if (!outForDeliveryOrders || outForDeliveryOrders.length === 0) return "";
      const items = outForDeliveryOrders.map((o) => `• ${o.item_name} from ${o.retailer}`).join("\n");
      const count = outForDeliveryOrders.length;
      return `\n\n[VERIFIED — Orders Out for Delivery Today]\n${items}\nCRITICAL: Mention this naturally near the start of the briefing. ${count === 1 ? `Say something like: "Your ${outForDeliveryOrders[0].item_name} from ${outForDeliveryOrders[0].retailer} is out for delivery today."` : `Say something like: "${count} packages arriving today — your ${outForDeliveryOrders.map((o) => o.item_name).join(" and ")}." `}Keep it brief — one sentence.`;
    })();

    const todosBlock = todayReminders.length > 0
      ? `\n\n[VERIFIED — To-Dos & Reminders]\n` +
        todayReminders.map(r => {
          const time = r.fire_at
            ? new Date(r.fire_at).toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true })
            : null;
          return time ? `• ${r.reminder_text} — ${time}` : `• ${r.reminder_text}`;
        }).join("\n")
      : "";

    const calendarBlock = todayEvents && todayEvents.length > 0
      ? `\n\n[VERIFIED — Calendar — Today]\n` +
        todayEvents.map(e => {
          const time = e.allDay ? "All day" : `${e.start}${e.end && e.end !== e.start ? ` – ${e.end}` : ""}`;
          const loc = e.location ? ` · ${e.location}` : "";
          return `• ${e.summary} — ${time}${loc}`;
        }).join("\n")
      : "";

    const profileContextBlock = buildProfileContext(
      userProfile ?? null,
      keyPeople
    );

    const peopleContextBlock = buildPeopleContextBlock(keyPeople, userProfile?.name ?? undefined);

    const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, userName);
    const preamble = getCurrentDateTimeBlock(timezone) + "\n" + corePrompt + profileContextBlock +
      memoryBlock + dynamicProfileBlock + prefsBlock + peopleContextBlock;

    // ── Apply briefing toggle preferences ─────────────────────────────────────
    const _bWeather = userSettings?.briefingWeather !== false ? weatherContextBlock : "";
    const _bNews    = userSettings?.briefingNews    !== false ? dedupedNewsBlock : "";
    let stoicEntry = userSettings?.briefingStoic !== false
      ? await getStoicForUser(userName).catch(() => null)
      : null;

    // If the quote is dense or inaccessible, swap in an alternative
    if (stoicEntry) {
      const accessible = await isStoicQuoteAccessible(stoicEntry.quote);
      if (!accessible) {
        const alt = await getAlternativeStoicQuote().catch(() => null);
        if (alt) {
          stoicEntry = {
            dayNumber: stoicEntry.dayNumber,
            quote: alt.quote,
            author: alt.author,
            source: alt.source,
            theme: alt.theme,
            phase: stoicEntry.phase,
          };
          logger.info({ theme: alt.theme, author: alt.author }, "[Stoic] Dense quote detected — using alternative");
        }
      }
    }

    const stoicBlock = stoicEntry ? buildStoicBlock(stoicEntry) : "";

    const _bSports = sportsBlock || "";

    const suffix = [
      _bWeather,
      calendarBlock,
      todosBlock,
      ordersBlock,
      _bNews,
      _bSports,
      stoicBlock,
      onboardingNudgeBlock,
      buildNarrativeBriefingInstruction(
        primaryCity,
        userProfile?.companionName ?? null,
        userProfile?.name ?? undefined,
        userSettings ?? undefined
      ),
    ].filter(Boolean).join("\n\n");

    // Log which static sections have data
    const sectionLog: Record<string, boolean | string> = {
      "weather": weatherContextBlock.length > 0,
      "calendar": calendarBlock.length > 0,
      "todos": todosBlock.length > 0,
      "news": dedupedNewsBlock.length > 0,
      "sports": !!(sportsScores),
      "orders": outForDeliveryOrders.length > 0,
    };
    logger.info({ userName, sections: sectionLog }, "[BRIEFING SECTIONS] Static data availability per section");

    setStaticBriefingContext(userName, {
      preamble,
      suffix,
      candidateStoryKeys,
      dateKey: generationDateKey,
      builtAt: Date.now(),
    });

    logger.info(
      { userName, preambleChars: preamble.length, suffixChars: suffix.length, dateKey: generationDateKey },
      "Static briefing context cached — generating full briefing"
    );

    // ── Full briefing generation — single Claude call, fully pre-staged ───────
    try {
      const t0pregen = Date.now();
      const fullSystem = preamble + suffix;
      const anthropic = new Anthropic();
      const pregenResult = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          system: fullSystem,
          messages: [{ role: "user", content: "good morning" }],
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 45000)),
      ]);

      if (pregenResult && pregenResult.content[0]?.type === "text") {
        const briefingText = pregenResult.content[0].text;
        setCachedBriefing(userName, briefingText, generationDateKey);
        incrementStoicDay(userName).catch((e) => logger.warn({ e }, "[Stoic] Failed to increment stoic day"));
        logger.info(
          { userName, chars: briefingText.length, totalMs: Date.now() - t0pregen },
          "[MorningPush] Full briefing pre-generated and cached — native delivery will be instant"
        );
      } else {
        logger.warn({ userName }, "[MorningPush] Pre-gen Claude call timed out or returned empty — native path will regenerate on first call");
      }
    } catch (pregenErr) {
      logger.warn({ pregenErr, userName }, "[MorningPush] Full briefing pre-generation failed — native path will regenerate on first call");
    }
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing static context");
  }
}

// ── Experimental: single-call GPT-4o daily brief via Responses API + web search ──
// NOT wired into _doBriefingPrefetch, the cron schedule, or any other live path.
// Build-only step — call manually to test before it replaces the existing
// news/weather/sports/local-content pipeline in a later pass.

const DAILY_BRIEF_INSTRUCTION = `Do several real web searches — don't stop after one. Search for: today's top news headlines (aim for at least 5 real stories worth knowing, not just one), today's weather for this person's city, market/investing news, sports scores for their teams, and one or two genuinely funny or delightful "you won't believe this" news stories from today. Then write them a genuinely enjoyable five-minute morning brief covering all of that. Also search for real local events happening today or this weekend near their city that match their actual interests or goals (concerts, tastings, exhibits, etc.) — mention one or two if you find something genuinely worth it, skip entirely if nothing good turns up. Use only real, current, verified information from your searches — never invent facts, venues, dates, scores, or weather. Style it however reads best for a five-minute morning read — sections, headers, or flowing prose, your call, and vary the structure day to day rather than repeating an identical template every time. Don't hold back on length or detail — a good five-minute read has real substance, not just one or two lines per topic. For loose style reference only (not a required template), here are two briefings this person said they liked:

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
Before the opening bell: Dow futures lower, S&P 500 futures lower, Nasdaq futures sharply lower. The main story is a broad technology and semiconductor pullback. Even strong earnings from some chip companies haven't reassured investors, who are becoming more selective about AI-related valuations. Netflix is also under pressure after issuing weaker guidance. Investor takeaway: if you're a long-term investor, this looks more like a valuation reset than a sign that AI itself is losing importance.

🏈🏀⚾ Pro Sports
A relatively quiet morning for the Dallas teams: Cowboys training camp storylines are beginning to build as preseason approaches. Rangers continuing their push through the regular season with the trade deadline approaching. Mavericks offseason roster development remains the focus. Stars quiet offseason as preparations continue for training camp. Internationally, the biggest sports story is the buildup to the upcoming World Cup Final.

🤖 AI & Technology
The biggest AI story today isn't a new model — it's the market. Investors are asking whether the hundreds of billions being spent on AI chips, data centers, and infrastructure will generate enough profits to justify current valuations. That debate is driving today's technology selloff.

😂 No Politics, Just Weird
A Labrador had to be rescued from Britain's highest mountain after apparently eating marijuana during a hike. Mountain rescuers carried the very relaxed dog back down. Also, authorities are still trying to capture a wandering emu that has become something of a local celebrity by calmly strolling through neighborhoods while avoiding capture.

🍷 Daily Discovery
Wine Tip of the Day: If you enjoy Cabernet Sauvignon, try a Bordeaux blend from France. Unlike many California Cabernets, Bordeaux often blends Cabernet Sauvignon with Merlot and Cabernet Franc, producing a more restrained, food-friendly style. It's an excellent comparison tasting that helps develop your palate.

💬 Quote of the Day
"The important thing is not to stop questioning." — Albert Einstein

👍 Things You Can Safely Ignore
Every dramatic prediction that "AI is over" — the technology continues to advance, even if the stocks experience periods of volatility. Also, hour-by-hour market swings — if you're investing for years rather than days, today's headlines are usually much less important than they seem.

Have a great Friday!

[EXAMPLE 2]
📍 Around Dallas
Smooth jazz tonight at The Balcony Club. Free evening at the Nasher Sculpture Center's 'til Midnight at the Nasher with live music, food, and late-night access to the museum. If you're looking for a Saturday outing, the Dallas Farmers Market and the Deep Ellum Outdoor Market are both great options.

🗓️ If I Were You Today…
Grab coffee, head to the Farmers Market, then catch a jazz set at Revelers Hall tonight. It's less about listing events and more about giving one enjoyable way to spend the day.

End with today's Stoic quote provided above, woven in naturally as a closing thought, not just pasted verbatim.`;

interface OpenAiResponsesResult {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

export async function generateDailyBrief(userName: string): Promise<string | null> {
  try {
    const [profile, goals, memories, stoic] = await Promise.all([
      getProfile(userName).catch(() => null),
      getGoals(userName).catch((): Awaited<ReturnType<typeof getGoals>> => []),
      getRecentMemories(7).catch(() => []),
      getStoicForUser(userName).catch(() => null),
    ]);

    const name = profile?.name ?? userName;
    const city = profile?.city ?? "an unknown city";

    const interestParts: string[] = [];
    if (profile?.hobbies?.length)        interestParts.push(`hobbies: ${profile.hobbies.join(", ")}`);
    if (profile?.musicGenres?.length)    interestParts.push(`music genres: ${profile.musicGenres.join(", ")}`);
    if (profile?.favoriteArtists?.length) interestParts.push(`favorite artists: ${profile.favoriteArtists.join(", ")}`);
    if (profile?.sportsTeams)            interestParts.push(`sports teams: ${profile.sportsTeams}`);
    const interestsLine = interestParts.length > 0 ? interestParts.join("; ") : "no specific interests on file";

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

    const contextBlock =
`Today's date: ${today}
Name: ${name}
City: ${city}
Interests: ${interestsLine}
Active goals: ${goalsLine}
Recent context: ${memoriesBlock || "no recent conversation memories"}
Today's reflection: ${stoicLine}`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn({ userName }, "[DailyBrief] OPENAI_API_KEY not configured — skipping");
      return null;
    }

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        tools: [{ type: "web_search_preview" }],
        input: `${contextBlock}\n\n${DAILY_BRIEF_INSTRUCTION}`,
        max_output_tokens: 4000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      logger.warn(
        { userName, status: resp.status, errText: errText.slice(0, 500) },
        "[DailyBrief] OpenAI Responses API returned non-OK status"
      );
      return null;
    }

    const data = await resp.json() as OpenAiResponsesResult;
    const messageItem = data.output?.find((item) => item.type === "message");
    const textItem = messageItem?.content?.find((c) => c.type === "output_text" || c.type === "text");

    if (!textItem?.text) {
      logger.warn(
        { userName, raw: JSON.stringify(data).slice(0, 500) },
        "[DailyBrief] Unexpected Responses API shape — no output_text found"
      );
      return null;
    }

    return textItem.text;
  } catch (err) {
    logger.warn({ err, userName }, "[DailyBrief] generateDailyBrief failed");
    return null;
  }
}

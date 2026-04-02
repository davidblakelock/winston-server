import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function fetchMorningNews(): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();

  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const prompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating the morning news for David Blakelock in Dallas, Texas. Search the web for real current news from the past 24-48 hours. Be specific, factual, and include concrete details — dates, scores, names, percentages.

Search for and organize into three tiers:

TIER 1 — HARD RELEVANT NEWS (find exactly 3-4 of the most significant stories from this list):
- Texas Rangers: Did they play yesterday? Search "${yesterdayStr} Texas Rangers game score" to find the final score, who pitched, and any key moments. Include specific details.
- Dallas Cowboys: Any significant news? Off-season signings, trades, injuries, contract news, coaching developments.
- US Stock Market: What happened yesterday? Search "S&P 500 Dow Jones market ${yesterdayStr}" for index performance, percentage moves, and what drove the action.
- Global Politics: Any major world news from past 24 hours — significant government actions, international conflicts, elections, US policy, major international events?
- AI & Technology: Any major announcements or developments from OpenAI, Anthropic, Google DeepMind, Apple, Meta, or other tech companies in the past 48 hours?
- Dallas local: Any genuinely significant Dallas or Texas news? (Skip minor or routine local stories.)

TIER 2 — CULTURAL MOMENTS (find 1-2 stories):
- Any notable deaths of celebrities, public figures, athletes, musicians, politicians, or historical figures in the past 48 hours? Search "${todayStr} death obituary notable celebrity" to find any.
- Any major cultural event, big entertainment news, significant sports milestone, or remarkable human achievement the whole world is talking about?

TIER 3 — WATERCOOLER (find exactly 1 story):
- One genuinely interesting, surprising, funny, or remarkable story from the past week. The kind you'd share at a dinner party saying "did you hear about this?" Search "interesting surprising news today" or "weird news today" or "amazing discovery this week." Could be science, animals, human interest, a remarkable coincidence, an unexpected world record, something bizarre.

After searching, provide your summary in EXACTLY this format (use these exact tier labels so I can parse it):

TIER1:
• [Story 1: 2-3 sentence factual summary with specific details — include names, numbers, context for why it matters to someone in Dallas who follows the Rangers and Cowboys, invests in markets, and works in AI]
• [Story 2: 2-3 sentence factual summary]
• [Story 3: 2-3 sentence factual summary]
• [Story 4: 2-3 sentence factual summary — only if genuinely significant, otherwise omit this bullet]

TIER2:
• [Story 1: 1-2 sentence summary. For deaths: name, age if known, why notable.]
• [Story 2: 1-2 sentence summary — only if genuinely notable, otherwise omit]

TIER3:
• [One interesting/surprising/funny story in 1-2 sentences. Be specific.]

RULES:
- Only report stories you actually found via search. Never fabricate headlines or outcomes.
- If the Rangers played, ALWAYS include it in Tier 1 and lead with it.
- If no notable deaths were found, say "No notable deaths in past 48 hours" for Tier 2.
- For Tier 3, always find something even if you need to broaden the time window to past week.
- Include specific numbers, names, scores wherever possible.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("\n")
      .trim();

    if (!text) {
      logger.warn("Morning news web search returned no text");
      return "";
    }

    logger.info({ chars: text.length }, "Morning news fetched via web search");
    return formatNewsBlock(text);
  } catch (err) {
    logger.warn({ err }, "Morning news web search failed");
    return "";
  }
}

function formatNewsBlock(rawText: string): string {
  // Parse out each tier from Claude's structured response
  const tier1Match = rawText.match(/TIER1:([\s\S]*?)(?=TIER2:|$)/i);
  const tier2Match = rawText.match(/TIER2:([\s\S]*?)(?=TIER3:|$)/i);
  const tier3Match = rawText.match(/TIER3:([\s\S]*?)$/i);

  const tier1 = tier1Match?.[1]?.trim() ?? "";
  const tier2 = tier2Match?.[1]?.trim() ?? "";
  const tier3 = tier3Match?.[1]?.trim() ?? "";

  const sections: string[] = [];
  if (tier1) sections.push(`[TIER 1 — Hard Relevant News]\n${tier1}`);
  if (tier2 && !tier2.toLowerCase().includes("no notable deaths")) {
    sections.push(`[TIER 2 — Cultural Moments]\n${tier2}`);
  }
  if (tier3) sections.push(`[TIER 3 — Watercooler]\n${tier3}`);

  if (!sections.length) return "";

  return (
    `\n\n[Morning News — web-searched this morning, real stories from past 24-48 hours]\n` +
    sections.join("\n\n") +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver the news as one flowing conversation — no tier labels, no section headers. Guidelines:\n` +
    `• LEAD with the Tier 1 story most relevant to David today. If the Rangers played last night, lead with the score. If there was a major market move, lead with that. Use your judgment on what he'd most want to hear first.\n` +
    `• TIER 1 stories: 2-3 sentences each with context for why it matters to David — his portfolio, Dallas, his teams, the AI space he's watching.\n` +
    `• TIER 2 stories: introduce naturally — "Also worth knowing —" or just flow from a Tier 1 story. 1-2 sentences each. Frame as "worth knowing."\n` +
    `• TIER 3 story: end with this one. Introduce with something like "And here's one you'll want to share at pickleball today —" or "Oh, and this one's interesting." Keep it brief and light.\n` +
    `• The entire news section should take no more than 2 minutes spoken aloud at a conversational pace.\n` +
    `• Never say "Tier 1", "Tier 2", "Tier 3", "Hard News", "Watercooler", "Cultural Moments", or any section label.\n` +
    `• Never say "In other news", "Moving on to", "Speaking of which" — just flow naturally.`
  );
}

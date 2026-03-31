import { logger } from "../lib/logger.js";

export interface RssItem {
  title: string;
  description: string;
  pubDate: string;
}

export interface NewsFeed {
  category: string;
  items: RssItem[];
  error?: boolean;
}

// Simple RSS/XML parser — no external dependencies
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRssItems(xml: string, maxItems = 5): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const descRegex = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/;
  const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const itemXml = match[1];
    const title = stripHtml(titleRegex.exec(itemXml)?.[1] ?? "").trim();
    const rawDesc = descRegex.exec(itemXml)?.[1] ?? "";
    const description = stripHtml(rawDesc).substring(0, 300).trim();
    const pubDate = pubDateRegex.exec(itemXml)?.[1]?.trim() ?? "";

    if (title && title.toLowerCase() !== "title") {
      items.push({ title, description, pubDate });
    }
  }
  return items;
}

async function fetchFeed(
  category: string,
  url: string,
  maxItems = 4
): Promise<NewsFeed> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn({ category, status: res.status }, "RSS feed non-OK");
      return { category, items: [], error: true };
    }

    const xml = await res.text();
    const items = parseRssItems(xml, maxItems);
    return { category, items };
  } catch (err) {
    logger.warn({ category, err }, "RSS feed fetch failed");
    return { category, items: [], error: true };
  }
}

// All news feeds for David's interests
const FEEDS = [
  {
    category: "Markets & Finance",
    url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    max: 4,
  },
  {
    category: "Texas Rangers",
    url: "https://news.google.com/rss/search?q=Texas+Rangers+baseball&hl=en-US&gl=US&ceid=US:en",
    max: 3,
  },
  {
    category: "Dallas Cowboys",
    url: "https://news.google.com/rss/search?q=Dallas+Cowboys+NFL&hl=en-US&gl=US&ceid=US:en",
    max: 3,
  },
  {
    category: "Dallas Local News",
    url: "https://news.google.com/rss/search?q=Dallas+Texas+local+news&hl=en-US&gl=US&ceid=US:en",
    max: 4,
  },
  {
    category: "Global Politics",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    max: 4,
  },
  {
    category: "Technology & AI",
    url: "https://news.google.com/rss/search?q=artificial+intelligence+AI+technology+news&hl=en-US&gl=US&ceid=US:en",
    max: 4,
  },
];

export async function fetchMorningNews(): Promise<NewsFeed[]> {
  const results = await Promise.allSettled(
    FEEDS.map((f) => fetchFeed(f.category, f.url, f.max))
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { category: FEEDS[i].category, items: [], error: true }
  );
}

export function formatNewsForPrompt(feeds: NewsFeed[]): string {
  const sections = feeds
    .filter((f) => f.items.length > 0)
    .map((f) => {
      const headlines = f.items
        .map((item, i) => `${i + 1}. ${item.title}${item.description ? ` — ${item.description}` : ""}`)
        .join("\n");
      return `[${f.category}]\n${headlines}`;
    })
    .join("\n\n");

  if (!sections) return "";

  return (
    `\n\n[Morning News — current headlines fetched just now for David's interests]\n` +
    sections +
    `\n\n[News briefing instructions for Emma]\n` +
    `Include a conversational news briefing in your morning response using the headlines above. Guidelines:\n` +
    `• Select the 5-6 most interesting and relevant stories\n` +
    `• If Rangers or Cowboys had a game last night, lead with the score and result\n` +
    `• If there is significant stock market movement, mention it near the top\n` +
    `• Include Dallas local news only if something genuinely significant happened\n` +
    `• Summarize each story in 2-3 sentences — explain why it matters to David specifically (he lives in Dallas, follows the Rangers and Cowboys, invests in markets, and is building his own AI product)\n` +
    `• Tone: warm and conversational, like a trusted well-informed friend — not a news anchor reading a teleprompter\n` +
    `• Format: flowing prose, NOT a numbered list or bullet points\n` +
    `• End with the AI/technology story since David is actively building in that space\n` +
    `• Keep the entire news section under 280 words`
  );
}

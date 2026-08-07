import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";
import { firstUrl, contentTextWithoutUrl } from "../lib/emailForwardParsing.js";
import { addItems, getListType, convertListToChecklist } from "./listManager.js";

// ── Recipe email-forward import ──────────────────────────────────────────────
// Triggered by inboundEmail.ts when the subject matches /recipe/i (an
// independent branch, checked before the Attic's subject match). Paths,
// decided by what's actually in the body:
//   1. Just a link, no real pasted content → fetch the page, try schema.org/
//      Recipe JSON-LD first (the common case — 5/5 real sites checked during
//      investigation had it), fall back to a Claude extraction from the
//      stripped page text if it's absent.
//   2. Plain text with no url, or a url alongside pasted text worth keeping
//      as a reference → skip the fetch entirely, extract directly from what
//      was pasted (same shape as chat-driven recipe extraction).
//   3. No usable text/url result (including a body with no text at all —
//      e.g. a forwarded screenshot) but one or more image attachments came
//      through → hand the images straight to Claude's vision input. A photo
//      of a recipe (card, cookbook page, screenshot of a recipe site) has no
//      text for the steps above to work with at all otherwise.
//   4. Nothing usable → skip, no partial/garbage save. This is a one-shot
//      import with nobody to ask, so silence is the only honest outcome when
//      extraction comes back empty.
// Always saves to the fixed "recipes" list via the same addItems() path
// chat-driven saves already use — title in item_text, full recipe in notes,
// source url when there is one.

interface ParsedRecipe {
  title:   string;
  content: string;
}

export interface EmailImage {
  mimeType: string;
  base64:   string;
}

// Anthropic caps a single image at 5MB — this is the base64-encoded size, so
// the underlying file needs to be smaller still, but checking the encoded
// size directly avoids a second unit conversion.
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
// Vision calls cost more than text extraction and a recipe photo rarely
// needs more than one or two images to cover — cap how many get sent.
const MAX_IMAGES = 3;

// Body text below this length (after removing the found url and cutting at
// the signature marker) reads as "just a link with a one-line wrapper," not
// a real pasted recipe — a plain length check, nothing fancier.
const CONTENT_TEXT_THRESHOLD = 150;

// Caps how much of a fetched page's stripped text reaches the Claude
// fallback — recipe content is almost always near the top of the page
// (ingredients/instructions before comments, related posts, etc.), so
// capping from the start is a reasonable heuristic.
const PAGE_TEXT_CAP = 15000;

// Mirrors the cap the Attic path already uses for pasted email bodies.
const PASTED_TEXT_CAP = 8000;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ── Step 1: page fetch ────────────────────────────────────────────────────────

async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, "[RecipeEmailImport] page fetch returned non-OK status");
      return null;
    }
    return await resp.text();
  } catch (err) {
    logger.warn({ err, url }, "[RecipeEmailImport] page fetch failed");
    return null;
  }
}

// ── Step 2a: schema.org/Recipe JSON-LD extraction (the cheap, common path) ───
// Handles the real-world variance found during investigation: @type as a
// plain string or an array (["Recipe","NewsArticle"]), content wrapped in a
// bare array or a @graph array, and recipeInstructions as an array of
// HowToStep objects, an array of plain strings, or a single string with all
// steps bundled together (seen on Half Baked Harvest).

function formatInstructions(instructions: unknown): string {
  if (!instructions) return "";
  if (typeof instructions === "string") return instructions.trim();
  if (Array.isArray(instructions)) {
    return instructions
      .map((step, i) => {
        const text = typeof step === "string" ? step : (step as { text?: string })?.text ?? "";
        return text.trim() ? `${i + 1}. ${text.trim()}` : null;
      })
      .filter((s): s is string => !!s)
      .join("\n");
  }
  return "";
}

function extractRecipeJsonLd(html: string): ParsedRecipe | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const graph = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["@graph"] : undefined;
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(graph) ? graph : [parsed];

    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const typeVal = obj["@type"];
      const isRecipe = typeVal === "Recipe" || (Array.isArray(typeVal) && typeVal.includes("Recipe"));
      if (!isRecipe) continue;

      const name = decodeEntities(String(obj.name ?? "").trim());
      const ingredients = Array.isArray(obj.recipeIngredient)
        ? (obj.recipeIngredient as unknown[]).map((s) => decodeEntities(String(s)))
        : [];
      const instructionsText = decodeEntities(formatInstructions(obj.recipeInstructions));

      if (!name || (ingredients.length === 0 && !instructionsText)) continue; // sanity check — malformed/incomplete, let the caller fall through

      const ingredientsBlock = ingredients.length
        ? `Ingredients:\n${ingredients.map((i) => `- ${i}`).join("\n")}`
        : "";
      const content = [ingredientsBlock, instructionsText ? `Steps:\n${instructionsText}` : ""]
        .filter(Boolean)
        .join("\n\n");
      if (!content.trim()) continue;

      return { title: name, content };
    }
  }
  return null;
}

// ── Step 2b: aggressive strip for the Claude fallback ─────────────────────────
// Deliberately heavier than stripHtml()/stripNoiseTags() in the email
// scanners — those were built for already-small Gmail bodies where every
// other tag is left intact ("Claude reads the raw markup itself"). A full
// recipe webpage carries nav/header/footer/ads/comment-widget markup an
// email body never does, so this removes those block-level noise tags
// entirely before stripping the rest down to plain text.

function stripHtmlAggressive(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|header|footer|aside|form|iframe|svg|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, PAGE_TEXT_CAP);
}

// ── Claude-based extraction — shared by the page-fallback and pasted-text
// paths, since both just need "find the recipe in this text, or say NONE." ──

async function extractRecipeViaClaude(content: string, sourceDescription: string): Promise<ParsedRecipe | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || !content.trim()) return null;
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2000,
      system:
        `Find and extract the recipe from ${sourceDescription}. Return ONLY valid JSON: ` +
        `{"title": "short recipe name", "content": "the complete recipe — every ingredient, every step, formatted as clean readable text, never abbreviated or summarized"}. ` +
        `If there is no real recipe here (an error page, an index/listing page, a non-recipe email), return exactly: NONE`,
      messages: [{ role: "user", content }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!text || /^none$/i.test(text)) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { title?: string; content?: string };
    if (!parsed.title?.trim() || !parsed.content?.trim()) return null;
    return { title: parsed.title.trim(), content: parsed.content.trim() };
  } catch (err) {
    logger.warn({ err }, "[RecipeEmailImport] Claude extraction failed");
    return null;
  }
}

// ── Step 2b-ii: web_search fallback — for when the direct page fetch is
// blocked ────────────────────────────────────────────────────────────────
// Confirmed live: a real forwarded allrecipes.com link returned HTTP
// 402/403 to our own server's fetch (bot-blocked), AND Anthropic's own
// web_fetch tool got an explicit "url_not_allowed" for the same domain —
// allrecipes.com opts out of AI crawling entirely, so no direct-fetch
// approach can ever reach it. web_search is a genuinely different path: it
// can surface the recipe via search-result snippets, a syndicated/mirrored
// copy, or a cached version, without needing to fetch the blocked page
// directly. Not guaranteed to work for every blocked site, but strictly
// better than giving up immediately.
async function extractRecipeViaWebSearch(url: string): Promise<ParsedRecipe | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages: [{
        role: "user",
        content:
          `Find and extract the full recipe from this URL: ${url}\n\n` +
          `If you can't access that exact page directly, search for the recipe by its name/site and use the closest genuine match you can find (a syndicated copy, a cached version, etc.). ` +
          `Return ONLY valid JSON: {"title": "short recipe name", "content": "the complete recipe — every ingredient, every step, formatted as clean readable text, never abbreviated or summarized"}. ` +
          `If you genuinely can't find this recipe anywhere, return exactly: NONE`,
      }],
    });

    // web_search responses interleave narration text with tool-use blocks,
    // and the real answer itself can fragment across MANY text blocks split
    // at citation boundaries — same shape confirmed in briefingPregenerate.ts.
    // Take only text blocks after the last tool-related block, joined with
    // no separator (the fragments split mid-sentence, not at line breaks).
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

    if (!text || /^none$/i.test(text)) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { title?: string; content?: string };
    if (!parsed.title?.trim() || !parsed.content?.trim()) return null;
    return { title: parsed.title.trim(), content: parsed.content.trim() };
  } catch (err) {
    logger.warn({ err, url }, "[RecipeEmailImport] web_search fallback failed");
    return null;
  }
}

// ── Step 2c: vision extraction — for image-only forwards (photos/screenshots
// of a recipe, no usable body text) ──────────────────────────────────────────

async function extractRecipeFromImages(images: EmailImage[]): Promise<ParsedRecipe | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const usable = images
    .filter((img) => img.base64.length <= MAX_IMAGE_BASE64_BYTES)
    .slice(0, MAX_IMAGES);
  if (!anthropicKey || usable.length === 0) return null;
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          ...usable.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: img.base64 },
          })),
          {
            type: "text" as const,
            text:
              `Find and transcribe the recipe shown in ${usable.length > 1 ? "these images" : "this image"} ` +
              `(a photo or screenshot of a recipe card, cookbook page, or recipe website). Return ONLY valid JSON: ` +
              `{"title": "short recipe name", "content": "the complete recipe — every ingredient, every step, formatted as clean readable text, never abbreviated or summarized"}. ` +
              `If no real recipe is visible, return exactly: NONE`,
          },
        ],
      }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!text || /^none$/i.test(text)) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { title?: string; content?: string };
    if (!parsed.title?.trim() || !parsed.content?.trim()) return null;
    return { title: parsed.title.trim(), content: parsed.content.trim() };
  } catch (err) {
    logger.warn({ err }, "[RecipeEmailImport] Claude vision extraction failed");
    return null;
  }
}

// ── List-type guard ────────────────────────────────────────────────────────
// No conflict-check prompt here — there's no back-and-forth possible over
// email. But silently leaving "recipes" as notepad-type would reproduce the
// exact bug just fixed for chat-driven saves (a structured save landing
// somewhere the app can't render), so ensure it's checklist-type first,
// unconditionally, before writing.

async function ensureRecipesListIsChecklist(userName: string): Promise<void> {
  const type = await getListType(userName, "recipes").catch(() => "checklist");
  if (type === "notepad") {
    await convertListToChecklist(userName, "recipes").catch((err) =>
      logger.warn({ err, userName }, "[RecipeEmailImport] failed to convert recipes list to checklist")
    );
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface ImportRecipeParams {
  userName: string;
  text:     string;
  subject:  string;
  sender:   string;
  images?:  EmailImage[];
}

export async function importRecipeFromEmail(params: ImportRecipeParams): Promise<boolean> {
  const { userName, text, subject, sender, images = [] } = params;
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) {
    logger.info({ userName, subject }, "[RecipeEmailImport] empty body, no attachments — skipping");
    return false;
  }

  const url = trimmed ? firstUrl(trimmed) : null;
  const remainingText = trimmed ? contentTextWithoutUrl(trimmed, url) : "";
  const hasSubstantialPastedText = remainingText.length >= CONTENT_TEXT_THRESHOLD;

  let result: ParsedRecipe | null = null;
  const sourceUrl = url; // kept as a reference either way; only fetched in the link-only branch

  if (!trimmed) {
    // No body text at all — a bare forwarded photo/screenshot. Images below
    // are the only chance at extraction.
  } else if (url && !hasSubstantialPastedText) {
    // Just a link — fetch and extract from the page.
    const html = await fetchPageHtml(url);
    if (!html) {
      // Direct fetch blocked (bot protection, or the site opts out of AI
      // crawling entirely) — try web_search as a genuinely different path
      // before giving up. See extractRecipeViaWebSearch's doc comment.
      result = await extractRecipeViaWebSearch(url);
      if (result) {
        logger.info({ userName, url, title: result.title }, "[RecipeEmailImport] extracted via web_search fallback (direct fetch was blocked)");
      } else {
        logger.info({ userName, url, subject }, "[RecipeEmailImport] no recipe found — skipping");
        return false;
      }
    } else {
      result = extractRecipeJsonLd(html);
      if (result) {
        logger.info({ userName, url, title: result.title }, "[RecipeEmailImport] extracted via JSON-LD");
      } else {
        const stripped = stripHtmlAggressive(html);
        result = await extractRecipeViaClaude(
          stripped,
          "this webpage's text (already stripped of scripts/nav/ads, but may still contain some unrelated site content mixed in)"
        );
        if (result) {
          logger.info({ userName, url, title: result.title }, "[RecipeEmailImport] extracted via Claude fallback (no JSON-LD found)");
        }
      }
    }
  } else {
    // Pasted text (with or without a reference url) — extract directly, no fetch.
    result = await extractRecipeViaClaude(trimmed.slice(0, PASTED_TEXT_CAP), "this forwarded email body");
    if (result) {
      logger.info({ userName, title: result.title, hasUrl: !!url }, "[RecipeEmailImport] extracted directly from pasted email text");
    }
  }

  if (!result && images.length > 0) {
    result = await extractRecipeFromImages(images);
    if (result) {
      logger.info({ userName, title: result.title, imageCount: images.length }, "[RecipeEmailImport] extracted via Claude vision from attached image(s)");
    }
  }

  if (!result) {
    logger.info({ userName, subject, sender, imageCount: images.length }, "[RecipeEmailImport] no recipe found — skipping");
    return false;
  }

  await ensureRecipesListIsChecklist(userName);

  try {
    const inserted = await addItems("recipes", [result.title], userName, undefined, result.content, sourceUrl);
    logger.info(
      { userName, title: result.title, insertedCount: inserted.length, hasUrl: !!sourceUrl },
      "[RecipeEmailImport] saved to recipes list"
    );
    return inserted.length > 0;
  } catch (err) {
    logger.warn({ err, userName }, "[RecipeEmailImport] addItems failed");
    return false;
  }
}

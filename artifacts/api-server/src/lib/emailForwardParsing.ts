// Shared parsing helpers for forwarded-email routes (inboundEmail.ts's Attic
// path and lists/recipeEmailImporter.ts's recipe path). Split out to a
// neutral location so neither route needs to import the other.

// Signature/footer links shouldn't win over a genuine content link. Two
// simple, deliberately non-exhaustive heuristics: (1) stop looking once a
// common signature/footer marker shows up, and (2) skip obvious image/
// tracking/social links even before that point.
export const SIGNATURE_MARKER = /\n--\s*\n|unsubscribe|update your profile|view this email in your browser|sent from my iphone|sent from my android/i;
const NON_CONTENT_URL = /^https?:\/\/(img|cdn|assets|static)\.|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|newoldstamp\.com|wixstatic\.com|gravatar\.com/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|svg|webp|bmp)(\?|$)/i;

export function firstUrl(text: string): string | null {
  const cutoff     = text.search(SIGNATURE_MARKER);
  const searchable = cutoff === -1 ? text : text.slice(0, cutoff);

  const candidates = searchable.match(/https?:\/\/\S+/g) ?? [];
  for (const raw of candidates) {
    const url = raw.replace(/[.,;:!?)<>]+$/, "");
    if (IMAGE_EXTENSION.test(url) || NON_CONTENT_URL.test(url)) continue;
    return url;
  }
  return null;
}

// Text remaining after removing the found URL and cutting at the signature
// marker — used to tell "a real pasted recipe that also happens to include a
// link" apart from "just a bare link with a one-line wrapper."
export function contentTextWithoutUrl(text: string, url: string | null): string {
  const cutoff     = text.search(SIGNATURE_MARKER);
  const searchable = cutoff === -1 ? text : text.slice(0, cutoff);
  const withoutUrl = url ? searchable.split(url).join(" ") : searchable;
  return withoutUrl.trim();
}

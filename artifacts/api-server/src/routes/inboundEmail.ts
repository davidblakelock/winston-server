import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { saveAtticItem } from "../attic/atticItemsManager.js";

const router: IRouter = Router();

// Mailgun posts either application/x-www-form-urlencoded (text-only) or
// multipart/form-data (when attachments are present). multer handles both;
// memoryStorage discards attachment bytes since we don't need them yet.
const upload = multer({ storage: multer.memoryStorage() });

// Content this route stores is capped defensively — forwarded email threads
// (especially HTML-to-text conversions) can run very long.
const MAX_CONTENT_CHARS = 8000;

// Signature/footer links shouldn't win over a genuine content link. Two
// simple, deliberately non-exhaustive heuristics: (1) stop looking once a
// common signature/footer marker shows up, and (2) skip obvious image/
// tracking/social links even before that point.
const SIGNATURE_MARKER = /\n--\s*\n|unsubscribe|update your profile|view this email in your browser|sent from my iphone|sent from my android/i;
const NON_CONTENT_URL  = /^https?:\/\/(img|cdn|assets|static)\.|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|newoldstamp\.com|wixstatic\.com|gravatar\.com/i;
const IMAGE_EXTENSION  = /\.(png|jpe?g|gif|svg|webp|bmp)(\?|$)/i;

function firstUrl(text: string): string | null {
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

// ── Inbound email webhook ─────────────────────────────────────────────────────
// The Attic's email-forward path: forward anything with "the attic" anywhere
// in the subject line (case-insensitive — "put it in the attic", "in the
// attic", "store it in the attic", etc. all match) to save+<username>@... and
// its raw content lands in attic_items. This route used to also extract
// structured My-Records data from forwards (trip/warranty/subscription/etc.)
// but that use case is handled by email scanning now — that branch has been
// removed rather than kept alongside this one.

router.post(
  "/inbound-email",
  upload.any(),
  async (req: Request, res: Response) => {
    // Mailgun requires a 200 OK quickly or it will retry delivery.
    res.sendStatus(200);

    const body = req.body as Record<string, string>;

    const recipient = body["recipient"]     ?? "";
    const sender    = body["sender"]        ?? "";
    const subject   = body["subject"]       ?? "";
    const text      = body["stripped-text"] ?? body["body-plain"] ?? "";

    // Extract +username from recipient — e.g.
    // save+davidblakelock@myrecords.getwinstonai.com → "davidblakelock"
    const plusMatch = recipient.match(/\+([^@]+)@/);
    const username  = plusMatch ? plusMatch[1] : null;

    process.stdout.write(
      "[InboundEmail] received\n" +
      "  recipient : " + recipient  + "\n" +
      "  username  : " + (username ?? "(none)") + "\n" +
      "  sender    : " + sender     + "\n" +
      "  subject   : " + subject    + "\n" +
      "  text      : " + text.slice(0, 300) + (text.length > 300 ? "…" : "") + "\n"
    );

    if (!username) {
      process.stdout.write("[InboundEmail] no +username in recipient — cannot assign user_name, skipping\n");
      return;
    }

    if (!/the attic/i.test(subject)) {
      process.stdout.write("[InboundEmail] subject doesn't mention 'the attic' — skipping\n");
      return;
    }

    if (text.trim().length === 0) {
      process.stdout.write("[InboundEmail] empty body — skipping\n");
      return;
    }

    const rawContent = text.trim().slice(0, MAX_CONTENT_CHARS);
    const rawUrl     = firstUrl(text);

    try {
      await saveAtticItem({
        userName:       username,
        sourceType:     "email_forward",
        rawContent,
        rawUrl,
        sourceMetadata: { subject, sender },
      });
      process.stdout.write("[InboundEmail] saved to attic_items for user: " + username + "\n");
    } catch (err) {
      process.stdout.write("[InboundEmail] attic_items insert failed: " + String(err) + "\n");
    }
  },
);

export default router;

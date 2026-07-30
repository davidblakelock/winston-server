import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { saveAtticItem } from "../attic/atticItemsManager.js";
import { runConnectionEngine } from "../connectionEngine/connectionEngineManager.js";
import { importRecipeFromEmail, type EmailImage } from "../lists/recipeEmailImporter.js";
import { firstUrl } from "../lib/emailForwardParsing.js";

const router: IRouter = Router();

// Mailgun posts either application/x-www-form-urlencoded (text-only) or
// multipart/form-data (when attachments are present). multer handles both,
// keeping attachment bytes in memory (they're small — capped below) so the
// recipe path can hand image attachments to Claude's vision input when a
// forward has no usable body text (e.g. a forwarded photo/screenshot).
const upload = multer({ storage: multer.memoryStorage() });

// Same 5MB-base64 cap recipeEmailImporter.ts enforces — checked again here
// so oversized attachments never even get base64-encoded.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Anthropic's vision input only accepts these four formats — anything else
// (e.g. HEIC straight off an iPhone camera) is filtered out rather than sent
// to a call that would just fail.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// The Content-Type an email attachment arrives with cannot be trusted — a
// mail client or Mailgun's own multipart parsing can mislabel it. Confirmed
// live: a screenshot arrived declared as image/jpeg while its actual bytes
// were PNG, and Claude's vision API correctly rejected the mismatch rather
// than silently misreading it ("the image was specified using the
// image/jpeg media type, but the image appears to be a image/png image").
// Sniff the real format from the file's own magic bytes instead of ever
// trusting the declared header.
function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Content this route stores is capped defensively — forwarded email threads
// (especially HTML-to-text conversions) can run very long.
const MAX_CONTENT_CHARS = 8000;

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
    // Mailgun's "stripped-text" heuristically removes quoted/forwarded
    // content and signature blocks — exactly the wrong thing for this route,
    // since every real payload here (a forwarded recipe, an Attic capture)
    // lives entirely inside that forwarded/quoted section. Confirmed live:
    // three separate test forwards all logged stripped-text as just the
    // sender's own auto-appended signature line, with the actual forwarded
    // body silently stripped out from under it. "body-plain" is the full,
    // unstripped plain-text body and is what forwards actually need.
    const text      = body["body-plain"] ?? body["stripped-text"] ?? "";

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

    // Recipe forwards — an independent branch, checked before the Attic's
    // subject match so the two stay cleanly separate. "recipe" is a much
    // more specific signal than the Attic's deliberately generic catch-all,
    // and a recipe forward needs real structured extraction into list_items
    // (title/notes/url), not the Attic's raw-content-dump behavior.
    if (/recipe/i.test(subject)) {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const images: EmailImage[] = [];
      for (const f of files) {
        if (f.size > MAX_IMAGE_BYTES) continue;
        const sniffed = sniffImageMimeType(f.buffer);
        if (!sniffed || !SUPPORTED_IMAGE_TYPES.has(sniffed)) continue;
        images.push({ mimeType: sniffed, base64: f.buffer.toString("base64") });
      }
      await importRecipeFromEmail({ userName: username, text, subject, sender, images });
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
      runConnectionEngine(username, "capture").catch((err) =>
        process.stdout.write("[InboundEmail] runConnectionEngine failed: " + String(err) + "\n")
      );
    } catch (err) {
      process.stdout.write("[InboundEmail] attic_items insert failed: " + String(err) + "\n");
    }
  },
);

export default router;

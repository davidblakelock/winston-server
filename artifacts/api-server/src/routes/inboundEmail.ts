import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";

const router: IRouter = Router();

// Mailgun posts either application/x-www-form-urlencoded (text-only) or
// multipart/form-data (when attachments are present). multer handles both;
// memoryStorage discards attachment bytes since we don't need them yet.
const upload = multer({ storage: multer.memoryStorage() });

// ── Inbound email webhook ─────────────────────────────────────────────────────

router.post(
  "/inbound-email",
  upload.any(),
  async (req: Request, res: Response) => {
    // Mailgun requires a 200 OK quickly or it will retry delivery.
    res.sendStatus(200);

    const body = req.body as Record<string, string>;

    const recipient  = body["recipient"]     ?? "";
    const sender     = body["sender"]        ?? "";
    const subject    = body["subject"]       ?? "";
    const text       = body["stripped-text"] ?? body["body-plain"] ?? "";

    // Extract +username from recipient — e.g.
    // save+davidblakelock@myrecords.getwinstonai.com → "davidblakelock"
    const plusMatch  = recipient.match(/\+([^@]+)@/);
    const username   = plusMatch ? plusMatch[1] : null;

    process.stdout.write(
      "[InboundEmail] received\n" +
      "  recipient : " + recipient  + "\n" +
      "  username  : " + (username ?? "(none)") + "\n" +
      "  sender    : " + sender     + "\n" +
      "  subject   : " + subject    + "\n" +
      "  text      : " + text.slice(0, 300) + (text.length > 300 ? "…" : "") + "\n"
    );
  },
);

export default router;

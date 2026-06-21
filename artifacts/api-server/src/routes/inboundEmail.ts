import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

const router: IRouter = Router();

const anthropic = new Anthropic();

const MODEL_HAIKU = "claude-haiku-4-5-20251001";

// Mailgun posts either application/x-www-form-urlencoded (text-only) or
// multipart/form-data (when attachments are present). multer handles both;
// memoryStorage discards attachment bytes since we don't need them yet.
const upload = multer({ storage: multer.memoryStorage() });

const EXTRACTION_SYSTEM_PROMPT = `Extract structured booking/confirmation information from this forwarded email. Return ONLY valid JSON, no markdown fences, no explanation.

{
  "category": "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other" | "skip",
  "vendor_name": "business or company name, or null",
  "confirmation_number": "string or null",
  "date_start": "YYYY-MM-DD or null",
  "date_end": "YYYY-MM-DD or null",
  "time": "string or null",
  "address": "string or null",
  "phone": "string or null",
  "website": "string or null",
  "amount": "string or null",
  "notes": "one sentence summary or null"
}

CRITICAL BOUNDARIES:
- Never extract bank account numbers, routing numbers, credit/debit card numbers, Social Security numbers, or financial account credentials.
- Never extract medical diagnoses, lab results, prescription details, or clinical health information.
- If the email's primary content is financial (bank statement, EOB, payment processing) or medical (lab results, diagnosis, clinical record), return category: "skip" and null for all other fields.
- Extract only logistics: confirmation numbers, vendor names, dates, times, addresses, phone numbers, websites. If a field isn't present, use null. Never guess or infer.`;

interface ExtractionResult {
  category: "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other" | "skip";
  vendor_name: string | null;
  confirmation_number: string | null;
  date_start: string | null;
  date_end: string | null;
  time: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  amount: string | null;
  notes: string | null;
}

function senderDomain(sender: string): string | null {
  const match = sender.match(/@([^>]+)/);
  return match ? match[1].trim() : null;
}

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

    // ── Extraction ────────────────────────────────────────────────────────────

    if (text.length < 20) {
      process.stdout.write("[InboundEmail] text too short to extract — skipping\n");
      return;
    }

    if (!username) {
      process.stdout.write("[InboundEmail] no +username in recipient — cannot assign user_name, skipping\n");
      return;
    }

    let extracted: ExtractionResult | null = null;
    try {
      const userMessage = `Subject: ${subject}\n\n${text}`;

      const resp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 512,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });

      const raw = resp.content[0]?.type === "text" ? resp.content[0].text : "";
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

      extracted = JSON.parse(cleaned) as ExtractionResult;
    } catch (err) {
      process.stdout.write("[InboundEmail] extraction failed: " + String(err) + "\n");
      return;
    }

    if (!extracted || extracted.category === "skip") {
      process.stdout.write("[InboundEmail] category=skip or null result — not inserting\n");
      return;
    }

    process.stdout.write(
      "[InboundEmail] extracted: " + JSON.stringify(extracted) + "\n"
    );

    // Vendor name falls back to sender's email domain if Claude returned null
    const vendorName = extracted.vendor_name ?? senderDomain(sender);
    const rawSnippet = text.slice(0, 500);

    try {
      await query(
        `INSERT INTO user_records
           (user_name, category, vendor_name, confirmation_number,
            date_start, date_end, time, address, phone, website,
            amount, notes, raw_email_snippet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          username,
          extracted.category,
          vendorName,
          extracted.confirmation_number,
          extracted.date_start,
          extracted.date_end,
          extracted.time,
          extracted.address,
          extracted.phone,
          extracted.website,
          extracted.amount,
          extracted.notes,
          rawSnippet,
        ]
      );
      process.stdout.write("[InboundEmail] inserted into user_records for user: " + username + "\n");
    } catch (err) {
      process.stdout.write("[InboundEmail] DB insert failed: " + String(err) + "\n");
    }
  },
);

export default router;

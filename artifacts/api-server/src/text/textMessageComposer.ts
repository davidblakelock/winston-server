// ── Text Message Composer ────────────────────────────────────────────────────
// Handles the "text [name]" flow:
//   1. Extract name from message
//   2. Look up phone number from contacts
//   3. Ask what the user wants to say
//   4. Compose message with Claude (tone calibrated by relationship)
//   5. Read back for confirmation
//   6. Return to native app with { phone, body } for SMS composer pre-fill
//
// Tone calibration:
//   - Family / close friends → casual, warm
//   - Doctors / business contacts → professional
//   - User can override: "make it more casual" / "make it more formal"

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tone detection ────────────────────────────────────────────────────────────

const PROFESSIONAL_KEYWORDS = [
  "doctor", "dr.", "physician", "dentist", "therapist", "lawyer", "attorney",
  "accountant", "accountant", "boss", "manager", "client", "coworker",
  "colleague", "business", "hr", "recruiter", "financial advisor", "banker",
  "insurance", "agent", "realtor", "contractor", "vendor", "supplier",
];

const CASUAL_KEYWORDS = [
  "wife", "husband", "partner", "girlfriend", "boyfriend", "daughter", "son",
  "mom", "dad", "mother", "father", "sister", "brother", "sister", "friend",
  "buddy", "pal", "aunt", "uncle", "cousin", "grandma", "grandpa",
  "grandmother", "grandfather", "family",
];

export type MessageTone = "casual" | "professional";

export function detectToneFromRelationship(relationship?: string): MessageTone {
  if (!relationship) return "casual";
  const lower = relationship.toLowerCase();
  if (PROFESSIONAL_KEYWORDS.some((k) => lower.includes(k))) return "professional";
  if (CASUAL_KEYWORDS.some((k) => lower.includes(k))) return "casual";
  return "casual";
}

// ── Name extraction ────────────────────────────────────────────────────────────

const TEXT_NAME_PATTERN = /^(?:text|send\s+(?:a\s+)?(?:text|message|sms)(?:\s+to)?|message)\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)/i;

export function extractTextTargetName(message: string): string | null {
  const m = TEXT_NAME_PATTERN.exec(message);
  if (!m) return null;
  const raw = m[1].trim();
  // Strip leading "my " so "my doctor" → "doctor", "my boss" → "boss"
  return raw.replace(/^my\s+/i, "").trim() || raw;
}

// ── Tone override detection ───────────────────────────────────────────────────

const MORE_CASUAL_PATTERN = /\b(make\s+it\s+more\s+(casual|informal|friendly|relaxed|warm)|more\s+(casual|informal|friendly|relaxed|warm))\b/i;
const MORE_FORMAL_PATTERN = /\b(make\s+it\s+more\s+(formal|professional|polished|business)|more\s+(formal|professional|polished|business))\b/i;

export function detectToneOverride(message: string): MessageTone | null {
  if (MORE_CASUAL_PATTERN.test(message)) return "casual";
  if (MORE_FORMAL_PATTERN.test(message)) return "professional";
  return null;
}

// ── Message composition ────────────────────────────────────────────────────────

export interface ComposeTextOptions {
  recipientName: string;
  relationship?: string;
  tone: MessageTone;
  userIntent: string;
  senderName?: string;
}

export interface ComposedMessage {
  body: string;
  tone: MessageTone;
}

export async function composeTextMessage(opts: ComposeTextOptions): Promise<ComposedMessage> {
  const { recipientName, relationship, tone, userIntent, senderName = NATIVE_STORED_NAME } = opts;

  const toneInstruction =
    tone === "professional"
      ? `Write a professional, polished text message. Keep it respectful, clear, and appropriately formal. ` +
        `No slang. No casual contractions. Sign off appropriately if needed.`
      : `Write a warm, casual text message. Keep it natural and friendly — the way ${senderName} actually talks. ` +
        `Conversational, brief, relaxed. No overly formal language.`;

  const relContext = relationship
    ? `The recipient is ${senderName}'s ${relationship}.`
    : `The recipient is a contact of ${senderName}'s.`;

  const prompt =
    `Write a text message FROM ${senderName} TO ${recipientName}.\n` +
    `${relContext}\n\n` +
    `CRITICAL: Write in FIRST PERSON as ${senderName}. ` +
    `The message must sound like ${senderName} wrote it themselves — ` +
    `use "I", "me", "my". DO NOT write in third person. ` +
    `DO NOT introduce yourself as an AI, assistant, or by any name. ` +
    `DO NOT say "this is [name]" or "on behalf of". ` +
    `Write exactly as ${senderName} would text — natural, direct, personal.\n\n` +
    `TONE: ${toneInstruction}\n\n` +
    `WHAT ${senderName.toUpperCase()} WANTS TO SAY:\n${userIntent}\n\n` +
    `Write ONLY the message body. No preamble. No explanation. No quotes around it. ` +
    `Keep it concise (1-4 sentences). No signature.`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Claude");

  return { body: block.text.trim(), tone };
}

// ── In-memory pending text state ─────────────────────────────────────────────
// Single-user for now (native mode is always NATIVE_USER)

export interface PendingTextState {
  phase: "awaiting_intent" | "awaiting_confirmation";
  recipientName: string;
  recipientPhone: string | null;
  relationship?: string;
  tone: MessageTone;
  composedBody?: string;
}

let _pendingText: PendingTextState | null = null;

export function getPendingText(): PendingTextState | null {
  return _pendingText;
}

export function setPendingText(state: PendingTextState | null): void {
  _pendingText = state;
  if (state) {
    logger.info({ phase: state.phase, recipient: state.recipientName }, "[TEXT] Pending state updated");
  } else {
    logger.info("[TEXT] Pending state cleared");
  }
}

// ── Confirmation detection ────────────────────────────────────────────────────

const CONFIRM_PATTERN = /^(yes|yeah|yep|yup|sure|send\s+it|looks\s+good|that'?s\s+(good|great|perfect|fine)|perfect|go\s+ahead|confirmed?|do\s+it|ok(ay)?|send\s+that|that\s+works?)\b/i;
const CANCEL_PATTERN = /^(no|nope|nah|don'?t\s+send|cancel|forget\s+it|never\s+mind|discard|scratch\s+that|hold\s+on)\b/i;

export function isSendConfirmation(message: string): boolean {
  return CONFIRM_PATTERN.test(message.trim());
}

export function isSendCancellation(message: string): boolean {
  return CANCEL_PATTERN.test(message.trim());
}

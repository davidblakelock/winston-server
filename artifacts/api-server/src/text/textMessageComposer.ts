// ── Text Message Composer ────────────────────────────────────────────────────
// Handles the "text [name]" flow:
//   1. Extract name from message
//   2. Look up phone number from contacts
//   3. Ask what the user wants to say
//   4. Compose message with Claude (tone calibrated by relationship or user request)
//   5. Read back for confirmation
//   6. Return to native app with { phone, body } for SMS composer pre-fill
//
// Supported tones:
//   casual        — warm and conversational (default for family/friends)
//   warm          — extra affectionate, caring
//   friendly      — upbeat, bright, encouraging
//   professional  — polished, respectful, business-appropriate
//   formal        — highly formal / business formal
//   playful       — fun, jokey, lighthearted
//   flirty        — romantic, suggestive, affectionate

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tone detection from relationship ─────────────────────────────────────────

const PROFESSIONAL_KEYWORDS = [
  "doctor", "dr.", "physician", "dentist", "therapist", "lawyer", "attorney",
  "accountant", "boss", "manager", "client", "coworker",
  "colleague", "business", "hr", "recruiter", "financial advisor", "banker",
  "insurance", "agent", "realtor", "contractor", "vendor", "supplier",
];

const CASUAL_KEYWORDS = [
  "wife", "husband", "partner", "girlfriend", "boyfriend", "daughter", "son",
  "mom", "dad", "mother", "father", "sister", "brother", "friend",
  "buddy", "pal", "aunt", "uncle", "cousin", "grandma", "grandpa",
  "grandmother", "grandfather", "family",
];

export type MessageTone = "casual" | "warm" | "friendly" | "professional" | "formal" | "playful" | "flirty";

export function detectToneFromRelationship(relationship?: string): MessageTone {
  if (!relationship) return "casual";
  const lower = relationship.toLowerCase();
  if (PROFESSIONAL_KEYWORDS.some((k) => lower.includes(k))) return "professional";
  if (CASUAL_KEYWORDS.some((k) => lower.includes(k))) return "casual";
  return "casual";
}

// ── Name extraction ────────────────────────────────────────────────────────────
// Allows optional preamble words (hey, ok, can you, please, etc.) before the trigger.
// This handles natural speech like "hey can you text Sarah" or "ok text Mom".

const PREAMBLE = /^(?:(?:ok|okay|hey|hi|alright|uh|um|so|listen|actually|well|and|also|please|can\s+you|could\s+you|will\s+you|would\s+you|i\s+(?:need|want)\s+(?:you\s+)?to)[,\s]+)*/i;

// Verb-first: "text Susan", "send a text to Susan", "message Susan" → name in group 1
const TEXT_TRIGGER_VERB_FIRST = /(?:text|send\s+(?:a\s+)?(?:text|message|sms)(?:\s+to)?|message)\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)/i;
// Name-first: "send Susan a text", "shoot Mom a message" → name in group 1
const TEXT_TRIGGER_NAME_FIRST = /(?:send|shoot|drop|give)\s+([A-Za-z][A-Za-z'.]*(?:\s+[A-Za-z][A-Za-z'.]*)?)\s+(?:a\s+)?(?:text|message|sms|note)/i;

export function extractTextTargetName(message: string): string | null {
  const stripped = message.replace(PREAMBLE, "").trim();

  // Try verb-first: "text Susan", "send a text to Susan"
  const m1 = TEXT_TRIGGER_VERB_FIRST.exec(stripped);
  if (m1) {
    const raw = m1[1].trim();
    return raw.replace(/^my\s+/i, "").trim() || raw;
  }

  // Try name-first: "send Susan a text", "shoot Mom a message"
  const m2 = TEXT_TRIGGER_NAME_FIRST.exec(stripped);
  if (m2) {
    const raw = m2[1].trim();
    return raw.replace(/^my\s+/i, "").trim() || raw;
  }

  return null;
}

// ── Tone override detection ───────────────────────────────────────────────────

const TONE_PATTERNS: Array<[RegExp, MessageTone]> = [
  [/\b(make\s+it\s+(?:more\s+)?(?:super\s+)?|(?:be\s+)?)(flirt(?:y|ier)|sexy|romantic|suggestive|intimate|seductive)\b/i, "flirty"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(playful|fun(?:ny)?|jokey|light(?:er)?|humorous|kidding|witty|cheeky|silly|teasing)\b/i, "playful"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(warm(?:er)?|loving|heartfelt|affectionate|sweet(?:er)?|tender|caring)\b/i, "warm"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(friendly|upbeat|bright(?:er)?|cheerful|encouraging|positive|enthusiastic)\b/i, "friendly"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(business\s+formal|very\s+formal|highly\s+formal|very\s+professional|super\s+professional)\b/i, "formal"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(formal|professional|polished|business|official|corporate|proper)\b/i, "professional"],
  [/\b(make\s+it\s+(?:more\s+)?|(?:be\s+)?)(casual|informal|relaxed|laid[\s-]?back|chill|easygoing|natural|conversational)\b/i, "casual"],
];

// Also detect tone requested inline (e.g. "text Mom in a flirty tone", "text Sarah something warm")
const INLINE_TONE: Array<[RegExp, MessageTone]> = [
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(flirt(?:y)?|sexy|romantic)\b/i, "flirty"],
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(playful|fun(?:ny)?|light(?:er)?|kidding|witty|cheeky|silly)\b/i, "playful"],
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(warm(?:er)?|loving|heartfelt|sweet(?:er)?|tender)\b/i, "warm"],
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(friendly|upbeat|cheerful|encouraging)\b/i, "friendly"],
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(formal|professional|polished|business)\b/i, "professional"],
  [/\b(?:in\s+a?\s*|make\s+it\s+|keep\s+it\s+)(casual|informal|relaxed|chill)\b/i, "casual"],
];

export function detectToneOverride(message: string): MessageTone | null {
  for (const [pattern, tone] of TONE_PATTERNS) {
    if (pattern.test(message)) return tone;
  }
  return null;
}

export function detectInlineTone(message: string): MessageTone | null {
  for (const [pattern, tone] of INLINE_TONE) {
    if (pattern.test(message)) return tone;
  }
  return null;
}

// Human-readable label for each tone (used in James Bond's read-back)
export function toneLabel(tone: MessageTone): string {
  switch (tone) {
    case "casual":       return "casual and natural";
    case "warm":         return "warm and heartfelt";
    case "friendly":     return "friendly and upbeat";
    case "professional": return "professional";
    case "formal":       return "business formal";
    case "playful":      return "playful and fun";
    case "flirty":       return "flirty";
  }
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

function buildToneInstruction(tone: MessageTone, senderName: string, recipientName: string): string {
  switch (tone) {
    case "casual":
      return (
        `Write a warm, casual text message. Keep it natural and friendly — the way ${senderName} actually talks. ` +
        `Conversational, brief, relaxed. No overly formal language.`
      );
    case "warm":
      return (
        `Write a warm, deeply caring text message. It should feel heartfelt and loving — ` +
        `the kind of message that makes ${recipientName} feel truly valued and thought of. ` +
        `Genuine emotion, no clichés. Brief but meaningful.`
      );
    case "friendly":
      return (
        `Write a bright, friendly, upbeat text message. Cheerful and encouraging — ` +
        `the kind that puts a smile on ${recipientName}'s face. Positive energy, conversational, brief.`
      );
    case "professional":
      return (
        `Write a professional, polished text message. Keep it respectful, clear, and appropriately formal. ` +
        `No slang. No casual contractions. Sign off appropriately if needed.`
      );
    case "formal":
      return (
        `Write a highly formal, business-formal text message. Structured, proper grammar, ` +
        `no contractions, no colloquialisms. Address ${recipientName} respectfully. ` +
        `This should read like a professional business communication.`
      );
    case "playful":
      return (
        `Write a fun, playful, lighthearted text message. Witty and charming — ` +
        `like ${senderName} is joking around with a good friend. ` +
        `Light humor is welcome. Keep it brief and entertaining. No seriousness.`
      );
    case "flirty":
      return (
        `Write a flirty, romantic text message. Suggestive but tasteful — ` +
        `playful and affectionate in a way that feels exciting and intimate. ` +
        `Light innuendo is fine. Keep it short and punchy — less is more. No explicit content.`
      );
  }
}

export async function composeTextMessage(opts: ComposeTextOptions): Promise<ComposedMessage> {
  const { recipientName, relationship, tone, userIntent, senderName = NATIVE_STORED_NAME } = opts;

  const toneInstruction = buildToneInstruction(tone, senderName, recipientName);

  const relContext = relationship
    ? `The recipient is ${senderName}'s ${relationship}.`
    : `The recipient is a contact of ${senderName}'s.`;

  const prompt =
    `Write a text message FROM ${senderName} TO ${recipientName}.\n` +
    `${relContext}\n\n` +
    `CRITICAL: Write in FIRST PERSON as ${senderName}. ` +
    `The message must sound like ${senderName} wrote it themselves — ` +
    `use "I", "me", "my". DO NOT write in third person. ` +
    `DO NOT say "on behalf of" or claim to be an assistant. ` +
    `Write exactly as ${senderName} would text — natural, direct, personal.\n\n` +
    `PRESERVE ALL CONTENT: If the user's intent mentions any specific names, nicknames, ` +
    `references, or phrases they explicitly want included, copy them EXACTLY into the message. ` +
    `Do NOT remove, replace, or paraphrase any proper nouns or specific references the user gave you. ` +
    `Your only job is to shape the TONE and STRUCTURE — the content is the user's, keep it intact.\n\n` +
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

export interface SmsPayload {
  phone: string;
  body: string;
  recipient: string;
  smsUri: string;
  // Stored so the flow can be restarted for editing after send
  relationship?: string;
  tone?: MessageTone;
}

let _pendingText: PendingTextState | null = null;
// Keeps the last dispatched SMS payload for up to 30 minutes so the user can
// retry if the native app didn't open Messages successfully.
let _lastSmsPayload: SmsPayload | null = null;
let _lastSmsPayloadAt: number = 0;
const SMS_RETRY_WINDOW_MS = 30 * 60 * 1000;

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

export function setLastSmsPayload(payload: SmsPayload): void {
  _lastSmsPayload = payload;
  _lastSmsPayloadAt = Date.now();
  logger.info({ recipient: payload.recipient }, "[TEXT] Last SMS payload stored for retry");
}

export function getLastSmsPayload(): SmsPayload | null {
  if (!_lastSmsPayload) return null;
  if (Date.now() - _lastSmsPayloadAt > SMS_RETRY_WINDOW_MS) {
    _lastSmsPayload = null;
    return null;
  }
  return _lastSmsPayload;
}

export function clearLastSmsPayload(): void {
  _lastSmsPayload = null;
}

// ── Confirmation detection ────────────────────────────────────────────────────

const CONFIRM_PATTERN = /^(?:(?:ok|okay|yeah|yep|yup|uh|um|sure|alright|sounds\s+good|looks?\s+good|great|perfect)[,\s]+)*(yes|send\s+it|looks?\s+good|that'?s\s+(?:good|great|perfect|fine)|perfect|go\s+ahead|confirmed?|do\s+it|okay|ok|send\s+that|that\s+works?)\b/i;
const CANCEL_PATTERN = /^(?:(?:actually|um|uh|wait|hold\s+on)[,\s]+)*(no|nope|nah|don'?t\s+send|cancel|forget\s+it|never\s+mind|discard|scratch\s+that)\b/i;

export function isSendConfirmation(message: string): boolean {
  return CONFIRM_PATTERN.test(message.trim());
}

export function isSendCancellation(message: string): boolean {
  return CANCEL_PATTERN.test(message.trim());
}

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../../db.js";
import { logger } from "../../lib/logger.js";
import {
  getProfile,
  buildSystemPromptFromProfile,
  buildPersonaPreamble,
  buildProfileContext,
  getCompanionDisplayName,
  type UserProfile,
} from "../../onboarding/onboardingManager.js";
import {
  getProfileItems,
  formatProfileForContext,
} from "../../profile/profileManager.js";
import { getPeople, type KeyPerson } from "../../people/peopleManager.js";
import {
  getBriefingPreferences,
  buildBriefingPrefsBlock,
  type BriefingPreference,
} from "../../briefingPreferences/briefingPreferencesManager.js";
import { getCurrentDateTimeBlock } from "../getCurrentDateTimeBlock.js";
import {
  getAllLists,
  addItems,
  batchCategorizeAndUpdateItems,
  syncListItemToConnections,
} from "../../lists/listManager.js";
import { createReminder } from "../../reminders/reminderManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../../google/calendar.js";
import { getCachedWeather } from "../../weather/weatherCache.js";
import { addBill } from "../../bills/billManager.js";
import { logMedicationsTaken, getMedications, hasTakenMedicationsToday } from "../../medications/medicationManager.js";
import {
  getPendingText,
  getLastSmsPayload,
} from "../../text/textMessageComposer.js";
import {
  getPendingReservation,
  type PendingReservation,
} from "../../restaurants/restaurantIntelligence.js";
import {
  getPendingEmailReply,
  getPendingMeetingRequests,
  type PendingEmailReply,
} from "../../email/emailMeetingManager.js";
import { findConnectionByLabel } from "../../connect/connectManager.js";
import { broadcastToUser } from "../../reminders/sseStore.js";
import { handleText } from "./textHandler.js";
import { handleEmailCalendar } from "./emailCalendarHandler.js";
import { handleReservation, type ReservationPayload } from "./reservationHandler.js";
import { handleContact } from "./contactHandlers.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";
const ACTIVE_CONTEXT_LIMIT = 20;
const TODAY_EVENTS_TTL_MS  = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionType =
  | "none"
  | "add_todo"
  | "add_reminder"
  | "add_todo_with_reminder"
  | "remind_contact"
  | "save_to_attic"
  | "search_contact"
  | "save_contact"
  | "make_reservation"
  | "send_sms"
  | "make_call"
  | "navigate"
  | "get_weather"
  | "get_markets"
  | "update_calendar"
  | "add_bill"
  | "log_medication"
  | "check_email";

export interface ClaudeAction {
  type: ActionType;
  // add_todo / add_todo_with_reminder
  listName?: string | null;
  itemText?: string | null;
  // add_reminder / add_todo_with_reminder / remind_contact
  reminderTime?: string | null;
  forContact?: string | null;
  // save_to_attic
  content?: string | null;
  // search_contact
  searchQuery?: string | null;
  // save_contact
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  saveDestination?: "my_people" | "service_providers" | "curated" | null;
  // make_reservation
  restaurantName?: string | null;
  // send_sms / make_call
  recipientName?: string | null;
  smsBody?: string | null;
  phone?: string | null;
  // navigate
  navigationTarget?: string | null;
  // update_calendar
  calendarIntent?: "read" | "create" | "modify" | "delete" | null;
  // add_bill
  billName?: string | null;
  billDueDay?: number | null;
  billAmount?: string | null;
  billNotes?: string | null;
}

interface ClaudeOutput {
  reply: string;
  action: ClaudeAction;
}

export interface NewChatRequest {
  sessionUserName: string;
  message: string;
  history: Array<{ role: string; content: string }>;
  timezone: string;
  deviceId: string | null;
  requestContext: string | null;
  bodyLat?: number | null;
  bodyLng?: number | null;
  log: {
    info:  (obj: object | string, msg?: string) => void;
    warn:  (obj: object | string, msg?: string) => void;
    error: (obj: object | string, msg?: string) => void;
  };
}

export interface NewChatResponse {
  reply: string;
  action: ClaudeAction;
  smsPayload?: import("../../text/textMessageComposer.js").SmsPayload;
  reservationPayload?: ReservationPayload;
  navigationUrl?: string;
}

// ── Per-user calendar cache ───────────────────────────────────────────────────

const _calCache = new Map<string, { events: CalendarEvent[]; fetchedAt: number }>();

async function getTodayEventsCached(userName: string): Promise<CalendarEvent[]> {
  const hit = _calCache.get(userName);
  if (hit && Date.now() - hit.fetchedAt < TODAY_EVENTS_TTL_MS) return hit.events;
  const events = (await fetchTodayEvents(userName).catch(() => null)) ?? [];
  _calCache.set(userName, { events, fetchedAt: Date.now() });
  return events;
}

// ── System prompt helpers ─────────────────────────────────────────────────────

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function buildSystemBlocks(stable: string, dynamic: string): SystemBlock[] {
  const blocks: SystemBlock[] = [];
  if (stable.length > 0) blocks.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
  if (dynamic.length > 0) blocks.push({ type: "text", text: dynamic });
  return blocks;
}

const BASE_SYSTEM_PROMPT = `You are __COMPANION__, __USER__'s personal AI companion.

MEMORY AND CONTEXT:
You remember context from this conversation and weave it in naturally when relevant — the way a friend would. Not mechanically at every turn, but you don't pretend the conversation started thirty seconds ago either. Pay attention. Connect things when it's natural to do so. Don't volunteer profile facts unprompted — but if something from earlier is genuinely relevant to right now, use it.

LISTS — STRICT RULE: You have no independent knowledge of what is on __USER__'s lists. If asked about a list and no list context block appears in this prompt, say: "I had trouble reading your list — try checking the list screen directly." Never guess or invent items.

TEXT MESSAGES — ABSOLUTE HONESTY RULE: You can COMPOSE text messages for __USER__ but you CANNOT send them. You have zero ability to send any message or touch __USER__'s phone. What you do: draft the message, read it back, and when __USER__ confirms, the app will ATTEMPT to open the Messages app with the text pre-filled. NEVER claim to have sent a message.

REMINDERS vs CALENDAR — CRITICAL DISTINCTION:
- REMINDERS (push notifications): "remind me to", "set a reminder", "don't let me forget" → push notification system
- GOOGLE CALENDAR: Only when __USER__ explicitly says "add to my calendar", "schedule an appointment", "book a meeting"
- IF AMBIGUOUS: Ask warmly: "Would you like me to set a reminder for that, or add it to your Google Calendar?"
NEVER create a Google Calendar event in response to "remind me."

BILLS: Winston only tracks bills that require MANUAL payment — credit cards being paid down, utilities paid by check, etc. If the user mentions adding a bill, extract the name, due day of month, and optional amount. Do NOT track bills that are automatically paid unless the user specifically asks.

GUIDING PRINCIPLE:
You are a knowledgeable, opinionated, genuinely helpful advisor. Be bold. Be specific. When you know something — say it directly, without hedging. You have access to web search and can answer questions about weather, sports, markets, news, and anything else the user asks — just answer naturally the way you would in any conversation.`;

function buildBaseSystemPrompt(
  userName?: string | null,
  persona?: "rosie" | "macc" | null,
  companionName?: string | null,
  personalityStyle?: string | null
): string {
  const user      = userName ?? "you";
  const companion = getCompanionDisplayName(persona ?? null, companionName ?? null);
  return (
    buildPersonaPreamble(persona ?? null, personalityStyle ?? null) +
    BASE_SYSTEM_PROMPT
      .replace(/__USER__/g, user)
      .replace(/__COMPANION__/g, companion)
  );
}

function buildListsBlock(allLists: Record<string, string[]>, skipList?: string | null): string {
  let block = "";
  for (const [listName, items] of Object.entries(allLists)) {
    // Skip the active list context — Claude would think items are already there
    if (skipList && listName.toLowerCase() === skipList.toLowerCase()) continue;
    if (items.length > 0) {
      block += `\n\n[${listName} list — current state]\n` +
        items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    }
  }
  return block;
}

function buildRemindersBlock(
  rows: Array<{ reminder_text: string; fire_at: string; for_contact: string | null }>,
  timezone: string
): string {
  if (rows.length === 0) return "";
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  return `\n\n[Active Reminders — ${rows.length} pending]\n` +
    rows.map((r, i) =>
      `${i + 1}. ${r.reminder_text}${r.for_contact ? ` (for ${r.for_contact})` : ""} — ${fmt(r.fire_at)}`
    ).join("\n");
}

function buildCalendarBlock(events: CalendarEvent[], timezone: string): string {
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const time = e.allDay
      ? "all day"
      : e.startIso
        ? new Date(e.startIso).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", timeZone: timezone,
          })
        : "";
    const loc = e.location ? ` at ${e.location}` : "";
    return `• ${e.summary}${time ? ` — ${time}` : ""}${loc}`;
  });
  return `\n\n[Today's Calendar]\n` + lines.join("\n");
}

// ── Action schema ─────────────────────────────────────────────────────────────

const ACTION_SCHEMA_BLOCK = `

[RESPONSE FORMAT — REQUIRED]
Always respond with valid JSON only. No markdown, no preamble, no explanation outside the JSON:
{
  "reply": "Your natural language response to the user",
  "action": {
    "type": "<action type>",
    ... action-specific fields ...
  }
}

AVAILABLE ACTION TYPES:
- "none"                  — General conversation, Q&A, weather, sports, markets, news — anything Claude can answer directly
- "add_todo"              → listName (string), itemText (comma-separated if multiple items)
- "add_reminder"          → itemText (what to remind), reminderTime (ISO 8601 with timezone offset)
- "add_todo_with_reminder"→ listName, itemText, reminderTime
- "remind_contact"        → itemText, reminderTime, forContact (first name)
- "search_contact"        → searchQuery (person's name)
- "save_contact"          → contactName, contactPhone (or null), contactEmail (or null), saveDestination ("my_people"|"service_providers"|"curated")
- "make_reservation"      → restaurantName
- "send_sms"              → recipientName, smsBody (or null to ask user for content)
- "make_call"             → recipientName, phone (or null)
- "navigate"              → navigationTarget (address or place name)
- "get_weather"           — User is asking about weather. Claude will answer using web search.
- "update_calendar"       → calendarIntent ("read"|"create"|"modify"|"delete")
- "add_bill"              → billName, billDueDay (number 1-31), billAmount (string like "$500" or null), billNotes (or null)
- "log_medication"        — User is saying they took their medications today
- "check_email"           — User wants to check, read, or review their email

RULES:
- Use "add_todo" whenever the user adds anything to any list. Always emit this action.
- Use "add_todo_with_reminder" when the user wants BOTH a list item AND a timed reminder (e.g. "remind me to call Olivia tomorrow at 2pm" → add to to-do list AND set reminder).
- Use "add_reminder" ONLY for timed reminders with no list item.
- Use "add_bill" ONLY for bills that require manual payment. Default frequency is monthly.
- Use "check_email" when the user asks to check, read, or review their email.
- Use "none" for weather, sports, markets, news — answer these directly using your knowledge and web search.
- reminderTime must be ISO 8601 with timezone offset. Infer the date if not explicit.
- Your reply should sound natural and acknowledge what you're doing inline.
- CRITICAL: reply must be plain conversational text only — never include JSON, code blocks, or structured data in the reply field.`;

// ── JSON extraction ───────────────────────────────────────────────────────────

function parseClaudeOutput(raw: string): ClaudeOutput | null {
  // Strategy 1: strip markdown fences and parse entire response as JSON
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as ClaudeOutput;
      if (parsed.reply && typeof parsed.reply === "string" && parsed.action?.type) {
        return parsed;
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: find first { to last }
  const braceStart = raw.indexOf("{");
  const braceEnd   = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(raw.slice(braceStart, braceEnd + 1)) as ClaudeOutput;
      if (parsed.reply && typeof parsed.reply === "string" && parsed.action?.type) {
        return parsed;
      }
    } catch { /* fall through */ }
  }

  // Strategy 3: extract just the reply field and default action to none
  const replyMatch = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (replyMatch?.[1]) {
    return {
      reply:  replyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
      action: { type: "none" },
    };
  }

  return null;
}

// ── History helpers ───────────────────────────────────────────────────────────

async function hydrateHistoryFromDb(
  userName: string
): Promise<Array<{ role: string; content: string }>> {
  const { rows } = await query<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
     WHERE user_name = $1
       AND (message_id IS NULL OR message_id NOT LIKE 'goals:%')
     ORDER BY created_at DESC LIMIT $2`,
    [userName, ACTIVE_CONTEXT_LIMIT]
  );
  return rows.reverse();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleNewChat(req: NewChatRequest): Promise<NewChatResponse> {
  const {
    sessionUserName,
    message,
    timezone,
    deviceId,
    requestContext,
    bodyLat  = null,
    bodyLng  = null,
    log,
  } = req;

  let history = req.history.slice(-ACTIVE_CONTEXT_LIMIT);

  // ── Load always-on context in parallel ─────────────────────────────────────
  const [
    userProfile,
    profileItems,
    keyPeople,
    briefingPrefs,
    allLists,
    pendingReminderRows,
    todayEvents,
    dbHistory,
  ] = await Promise.all([
    getProfile(sessionUserName).catch(() => null),
    getProfileItems(undefined, sessionUserName).catch(() => []),
    getPeople(sessionUserName).catch((): KeyPerson[] => []),
    getBriefingPreferences(sessionUserName).catch((): BriefingPreference[] => []),
    getAllLists(sessionUserName).catch(() => ({} as Record<string, string[]>)),
    query<{ reminder_text: string; fire_at: string; for_contact: string | null }>(
      `SELECT reminder_text, fire_at, for_contact FROM reminders
       WHERE user_name = $1 AND status = 'pending' ORDER BY fire_at ASC`,
      [sessionUserName]
    ).then((r) => r.rows).catch(
      (): Array<{ reminder_text: string; fire_at: string; for_contact: string | null }> => []
    ),
    getTodayEventsCached(sessionUserName),
    history.length === 0 ? hydrateHistoryFromDb(sessionUserName).catch(() => []) : Promise.resolve(null),
  ]);

  if (dbHistory !== null && history.length === 0) {
    history = dbHistory;
  }

  // ── Check for active multi-turn flows ───────────────────────────────────────
  const pendingText        = getPendingText(sessionUserName);
  const pendingReservation = getPendingReservation(sessionUserName);
  const pendingEmailReply  = getPendingEmailReply(sessionUserName);
  const pendingMeetingReqs = getPendingMeetingRequests(sessionUserName);

  // ── Build stable system prompt ───────────────────────────────────────────────
  const corePrompt =
    userProfile?.onboardingCompleted && userProfile.name
      ? buildSystemPromptFromProfile(userProfile)
      : buildBaseSystemPrompt(
          sessionUserName,
          userProfile?.companionPersona ?? null,
          userProfile?.companionName ?? null,
          userProfile?.personalityStyle ?? null
        );

  const profileContextBlock = buildProfileContext(userProfile, keyPeople);
  const stableSystem = corePrompt + profileContextBlock;

  // ── Build dynamic system prompt ──────────────────────────────────────────────
  const profileItemsBlock = formatProfileForContext(profileItems, sessionUserName);
  const prefsBlock        = buildBriefingPrefsBlock(briefingPrefs, sessionUserName);

  // Active screen context — tell Claude which list is active so it uses the right listName
  const activeScreenBlock = requestContext
    ? `\n\n[Active Screen: ${requestContext} list]\nWhen adding items without specifying a list, use "${requestContext}".`
    : "";

  let dynamicPrompt =
    getCurrentDateTimeBlock(timezone) +
    profileItemsBlock +
    prefsBlock +
    buildListsBlock(allLists, requestContext) +
    buildRemindersBlock(pendingReminderRows, timezone) +
    buildCalendarBlock(todayEvents, timezone) +
    activeScreenBlock;

  // ── Pre-flight: handle active multi-turn flows ───────────────────────────────

  // SMS flow in progress
  if (pendingText !== null) {
    const textResult = await handleText({
      message,
      sessionUserName,
      deviceId,
      isTextFlowActive: true,
      pendingText,
      isSmsRetryRequest:    /\bretry\b|\btry again\b/i.test(message),
      isSmsEditAfterSend:   /\bchange\b|\bedit\b|\bactually\b/i.test(message),
      lastSmsPayload:       getLastSmsPayload(sessionUserName),
      userProfile,
      log,
    });
    if (textResult.hardcodedResponse) {
      runPostProcessing(sessionUserName, message, textResult.hardcodedResponse, history, userProfile, deviceId);
      return {
        reply:      textResult.hardcodedResponse,
        action:     { type: "send_sms" },
        smsPayload: textResult.smsPayload,
      };
    }
    dynamicPrompt += textResult.contextBlock;
  }

  // Reservation flow in progress
  if (pendingReservation !== null) {
    const resResult = await handleReservation({
      message,
      sessionUserName,
      bodyLat,
      bodyLng,
      isRestaurantIntelRequest: false,
      isReservationFlowActive:  true,
      isReservationCancel:      /\bcancel\b|\bforget it\b|\bnevermind\b/i.test(message),
      isReservationCalAdd:      /\badd to calendar\b|\bput on calendar\b|\bschedule it\b/i.test(message),
      isMorningGreeting:        false,
      pendingReservation,
      userProfile,
      history,
      log,
    });
    if (resResult.hardcodedResponse) {
      runPostProcessing(sessionUserName, message, resResult.hardcodedResponse, history, userProfile, deviceId);
      return {
        reply:              resResult.hardcodedResponse,
        action:             { type: "make_reservation" },
        reservationPayload: resResult.reservationPayload,
      };
    }
    dynamicPrompt += resResult.contextBlock;
  }

  // Email reply flow in progress
  if (pendingEmailReply !== null || pendingMeetingReqs.length > 0) {
    const emailResult = await handleEmailCalendar({
      message,
      sessionUserName,
      timezone,
      corePrompt,
      memoryBlock: "",
      isDinnerTonightQuery:   false,
      isEmailRequest:         true,
      isCalendarRequest:      false,
      isCalendarWriteOp:      false,
      isDeleteConfirm:        false,
      isDeleteCancel:         false,
      isCalendarCreate:       false,
      isCalendarModify:       false,
      isCalendarDelete:       false,
      isEmailReplyFlowActive: true,
      isEmailReplyAccepted:   /\byes\b|\bsend\b|\bsounds good\b|\bthat works\b/i.test(message),
      pendingMeetingRequests: pendingMeetingReqs,
      pendingEmailReply,
      userProfile,
      log,
    });
    if (emailResult.hardcodedResponse) {
      runPostProcessing(sessionUserName, message, emailResult.hardcodedResponse, history, userProfile, deviceId);
      return {
        reply:  emailResult.hardcodedResponse,
        action: { type: "none" },
      };
    }
    dynamicPrompt += emailResult.contextBlock;
  }

  // ── Add action schema ────────────────────────────────────────────────────────
  dynamicPrompt += ACTION_SCHEMA_BLOCK;

  // ── Build messages array ─────────────────────────────────────────────────────
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: message },
  ];

  // ── Primary Claude call ──────────────────────────────────────────────────────
  const systemBlocks = buildSystemBlocks(stableSystem, dynamicPrompt);
  const primaryResponse = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 1024,
    system:     systemBlocks as Anthropic.TextBlockParam[],
    tools:      [{ type: "web_search_20250305" as const, name: "web_search" }],
    messages,
  });

  const textBlock = primaryResponse.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  const rawText = textBlock?.text ?? "";

  log.info(
    { inputTokens: primaryResponse.usage.input_tokens, outputTokens: primaryResponse.usage.output_tokens },
    "[chatHandlerCore] tokens"
  );

  const parsed = parseClaudeOutput(rawText);
  if (!parsed) {
    log.warn({ rawPreview: rawText.slice(0, 300) }, "[chatHandlerCore] Failed to parse Claude JSON");
    // Use raw text as fallback but strip any JSON that leaked in
    const fallbackReply = rawText
      .replace(/\s*\{[\s\S]*"reply"[\s\S]*\}[\s]*$/m, "")
      .trim() || "Sorry, I had trouble with that. Can you try again?";
    runPostProcessing(sessionUserName, message, fallbackReply, history, userProfile, deviceId);
    return { reply: fallbackReply, action: { type: "none" } };
  }

  const { reply: claudeReply, action } = parsed;
  log.info({ actionType: action.type }, "[chatHandlerCore] Action resolved");

  // ── Execute action ───────────────────────────────────────────────────────────
  let finalReply          = claudeReply;
  let smsPayload:         NewChatResponse["smsPayload"]          = undefined;
  let reservationPayload: ReservationPayload | undefined = undefined;
  let navigationUrl:      string | undefined                     = undefined;

  switch (action.type) {

    case "none":
      break;

    // ── add_todo ──────────────────────────────────────────────────────────────
    case "add_todo": {
      const listName = action.listName?.trim() || requestContext || "to do";
      const rawItems = action.itemText ?? "";
      const items    = rawItems.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) {
        try {
          const inserted = await addItems(listName, items, sessionUserName);
          // Categorize grocery items automatically
          if (listName.toLowerCase() === "shopping" && inserted.length > 0) {
            batchCategorizeAndUpdateItems(inserted).catch(() => {});
          }
          await syncListItemToConnections(listName, items, sessionUserName).catch(() => {});
          log.info({ listName, items }, "[chatHandlerCore] Items added to list");
        } catch (err) {
          log.warn({ err, listName, items }, "[chatHandlerCore] addItems failed");
        }
      }
      break;
    }

    // ── add_reminder ──────────────────────────────────────────────────────────
    case "add_reminder": {
      const itemText     = action.itemText?.trim() ?? "";
      const reminderTime = action.reminderTime ?? null;
      if (itemText && reminderTime) {
        try {
          const fireAt = new Date(reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({
              userName:     sessionUserName,
              reminderText: itemText,
              fireAt,
              timezone,
            });
            log.info({ itemText, fireAt }, "[chatHandlerCore] Reminder created");
          }
        } catch (err) {
          log.warn({ err, itemText }, "[chatHandlerCore] createReminder failed");
        }
      }
      break;
    }

    // ── add_todo_with_reminder ────────────────────────────────────────────────
    case "add_todo_with_reminder": {
      const listName = action.listName?.trim() || requestContext || "to do";
      const itemText = action.itemText?.trim() ?? "";
      const items    = itemText.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) {
        try {
          const inserted = await addItems(listName, items, sessionUserName);
          if (listName.toLowerCase() === "shopping" && inserted.length > 0) {
            batchCategorizeAndUpdateItems(inserted).catch(() => {});
          }
          await syncListItemToConnections(listName, items, sessionUserName).catch(() => {});
        } catch (err) {
          log.warn({ err, listName, items }, "[chatHandlerCore] add_todo_with_reminder list failed");
        }
      }
      if (itemText && action.reminderTime) {
        try {
          const fireAt = new Date(action.reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({
              userName:     sessionUserName,
              reminderText: itemText,
              fireAt,
              timezone,
            });
            log.info({ listName, itemText, fireAt }, "[chatHandlerCore] add_todo_with_reminder reminder created");
          }
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] add_todo_with_reminder reminder failed");
        }
      }
      break;
    }

    // ── remind_contact ────────────────────────────────────────────────────────
    case "remind_contact": {
      const itemText   = action.itemText?.trim() ?? "";
      const forContact = action.forContact?.trim() ?? null;
      if (itemText && action.reminderTime && forContact) {
        try {
          const fireAt = new Date(action.reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({
              userName:     sessionUserName,
              reminderText: itemText,
              fireAt,
              timezone,
              forContact,
            });
            // Winston Connect — mirror to connected user if found
            const connection = await findConnectionByLabel(sessionUserName, forContact).catch(() => null);
            if (connection?.recipientUserName) {
              await createReminder({
                userName:     connection.recipientUserName,
                reminderText: `A message from ${connection.senderLabel}: ${itemText}`,
                fireAt,
                timezone,
              }).catch(() => {});
            }
            log.info({ itemText, forContact, fireAt }, "[chatHandlerCore] remind_contact created");
          }
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] remind_contact failed");
        }
      }
      break;
    }

    // ── save_to_attic ─────────────────────────────────────────────────────────
    case "save_to_attic": {
      // Attic table not yet built — log for now, will wire in Phase 2
      const content = action.content?.trim() ?? message.trim();
      log.info({ content: content.slice(0, 100) }, "[chatHandlerCore] save_to_attic (pending Attic build)");
      break;
    }

    // ── search_contact ────────────────────────────────────────────────────────
    case "search_contact": {
      const contactResult = await handleContact({
        message,
        sessionUserName,
        isContactRequest:         true,
        isCompoundContactAndSave: /\b(?:and\s+)?(?:save|add)\b/i.test(message),
        isSaveContactRequest:     false,
        isGoogleContactWrite:     false,
        history,
        userProfile,
        log,
      });

      if (contactResult.contextBlock) {
        // Second pass with contact results in context
        const contactDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          contactResult.contextBlock +
          `\n\nRespond in plain conversational text — the user asked about a contact and the result is above. Summarize it naturally. No JSON.`;
        const followUp = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 300,
          system:     buildSystemBlocks(stableSystem, contactDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const followUpText = followUp.content[0]?.type === "text" ? followUp.content[0].text.trim() : "";
        if (followUpText) finalReply = followUpText;
      }
      break;
    }

    // ── save_contact ──────────────────────────────────────────────────────────
    case "save_contact": {
      await handleContact({
        message,
        sessionUserName,
        isContactRequest:         false,
        isCompoundContactAndSave: false,
        isSaveContactRequest:     true,
        isGoogleContactWrite:     /google|contacts app/i.test(message),
        history,
        userProfile,
        log,
      });
      break;
    }

    // ── make_reservation ─────────────────────────────────────────────────────
    case "make_reservation": {
      const resResult = await handleReservation({
        message,
        sessionUserName,
        bodyLat,
        bodyLng,
        isRestaurantIntelRequest: true,
        isReservationFlowActive:  false,
        isReservationCancel:      false,
        isReservationCalAdd:      false,
        isMorningGreeting:        false,
        pendingReservation:       null,
        userProfile,
        history,
        log,
      });
      if (resResult.hardcodedResponse) {
        finalReply         = resResult.hardcodedResponse;
        reservationPayload = resResult.reservationPayload;
      } else if (resResult.contextBlock) {
        const resDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          resResult.contextBlock +
          `\n\nRespond in plain conversational text — no JSON needed here.`;
        const followUp = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 300,
          system:     buildSystemBlocks(stableSystem, resDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const followUpText = followUp.content[0]?.type === "text" ? followUp.content[0].text.trim() : "";
        if (followUpText) finalReply = followUpText;
        reservationPayload = resResult.reservationPayload;
      }
      break;
    }

    // ── send_sms ──────────────────────────────────────────────────────────────
    case "send_sms": {
      const textResult = await handleText({
        message,
        sessionUserName,
        deviceId,
        isTextFlowActive:    true,
        pendingText:         null,
        isSmsRetryRequest:   false,
        isSmsEditAfterSend:  false,
        lastSmsPayload:      null,
        userProfile,
        log,
      });
      if (textResult.hardcodedResponse) {
        finalReply = textResult.hardcodedResponse;
        smsPayload = textResult.smsPayload;
      }
      break;
    }

    // ── make_call ─────────────────────────────────────────────────────────────
    case "make_call": {
      const phone = action.phone?.trim();
      if (phone) {
        const cleaned = phone.replace(/[^\d+]/g, "");
        navigationUrl = `tel:${cleaned}`;
        log.info({ recipientName: action.recipientName, phone: cleaned }, "[chatHandlerCore] make_call");
      }
      break;
    }

    // ── navigate ──────────────────────────────────────────────────────────────
    case "navigate": {
      const target = action.navigationTarget?.trim();
      if (target) {
        navigationUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target)}`;
        log.info({ target, navigationUrl }, "[chatHandlerCore] navigate");
      }
      break;
    }

    // ── get_weather ───────────────────────────────────────────────────────────
    // Weather is handled naturally by Claude using web search.
    // This case exists so the action is valid but Claude's reply already has the answer.
    case "get_weather":
      break;

    // ── get_markets ───────────────────────────────────────────────────────────
    // Markets handled naturally by Claude using web search.
    case "get_markets":
      break;

    // ── check_email ───────────────────────────────────────────────────────────
    case "check_email": {
      const emailResult = await handleEmailCalendar({
        message,
        sessionUserName,
        timezone,
        corePrompt,
        memoryBlock:            "",
        isDinnerTonightQuery:   false,
        isEmailRequest:         true,
        isCalendarRequest:      false,
        isCalendarWriteOp:      false,
        isDeleteConfirm:        false,
        isDeleteCancel:         false,
        isCalendarCreate:       false,
        isCalendarModify:       false,
        isCalendarDelete:       false,
        isEmailReplyFlowActive: false,
        isEmailReplyAccepted:   false,
        pendingMeetingRequests: [],
        pendingEmailReply:      null,
        userProfile,
        log,
      });
      if (emailResult.hardcodedResponse) {
        finalReply = emailResult.hardcodedResponse;
      } else if (emailResult.contextBlock) {
        const emailDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          emailResult.contextBlock +
          `\n\nRespond in plain conversational text — no JSON. Summarize the email naturally.`;
        const emailReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 600,
          system:     buildSystemBlocks(stableSystem, emailDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const emailText = emailReply.content[0]?.type === "text" ? emailReply.content[0].text.trim() : "";
        if (emailText) finalReply = emailText;
      }
      break;
    }

    // ── update_calendar ───────────────────────────────────────────────────────
    case "update_calendar": {
      const intent   = action.calendarIntent ?? "read";
      const isRead   = intent === "read";
      const isCreate = intent === "create";
      const isModify = intent === "modify";
      const isDelete = intent === "delete";

      const calResult = await handleEmailCalendar({
        message,
        sessionUserName,
        timezone,
        corePrompt,
        memoryBlock:            "",
        isDinnerTonightQuery:   /dinner tonight/i.test(message),
        isEmailRequest:         false,
        isCalendarRequest:      isRead,
        isCalendarWriteOp:      isCreate || isModify || isDelete,
        isDeleteConfirm:        false,
        isDeleteCancel:         false,
        isCalendarCreate:       isCreate,
        isCalendarModify:       isModify,
        isCalendarDelete:       isDelete,
        isEmailReplyFlowActive: false,
        isEmailReplyAccepted:   false,
        pendingMeetingRequests: [],
        pendingEmailReply:      null,
        userProfile,
        log,
      });

      if (calResult.hardcodedResponse) {
        finalReply = calResult.hardcodedResponse;
      } else if (calResult.contextBlock) {
        const calDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          calResult.contextBlock +
          `\n\nRespond in plain conversational text — no JSON. Answer the user's calendar question directly using the data above.`;
        const calReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 400,
          system:     buildSystemBlocks(stableSystem, calDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const calText = calReply.content[0]?.type === "text" ? calReply.content[0].text.trim() : "";
        if (calText) finalReply = calText;
      }
      break;
    }

    // ── add_bill ──────────────────────────────────────────────────────────────
    case "add_bill": {
      const billName   = action.billName?.trim();
      const billDueDay = action.billDueDay;
      if (billName && billDueDay && billDueDay >= 1 && billDueDay <= 31) {
        try {
          const result = await addBill(
            billName,
            "other",      // category — always other, Winston doesn't categorize bills
            "monthly",    // frequency — always monthly
            billDueDay,
            null,         // dueMonths
            action.billAmount ?? undefined,
            action.billNotes ?? undefined,
            sessionUserName
          );
          if (result.alreadyExists) {
            log.info({ billName }, "[chatHandlerCore] Bill already exists");
          } else {
            log.info({ billName, billDueDay }, "[chatHandlerCore] Bill added");
          }
        } catch (err) {
          log.warn({ err, billName }, "[chatHandlerCore] add_bill failed");
        }
      } else {
        log.warn({ billName, billDueDay }, "[chatHandlerCore] add_bill missing required fields");
      }
      break;
    }

    // ── log_medication ────────────────────────────────────────────────────────
    case "log_medication": {
      try {
        const alreadyTaken = await hasTakenMedicationsToday(sessionUserName);
        if (!alreadyTaken) {
          const meds = await getMedications(sessionUserName);
          if (meds.length > 0) {
            await logMedicationsTaken(meds, sessionUserName);
            log.info({ count: meds.length }, "[chatHandlerCore] Medications logged as taken");
          }
        } else {
          log.info("[chatHandlerCore] Medications already logged today");
        }
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] log_medication failed");
      }
      break;
    }
  }

  // ── Post-processing fire-and-forget ─────────────────────────────────────────
  runPostProcessing(sessionUserName, message, finalReply, history, userProfile, deviceId);

  return { reply: finalReply, action, smsPayload, reservationPayload, navigationUrl };
}

// ── Post-processing ───────────────────────────────────────────────────────────

function runPostProcessing(
  userName:    string,
  userMessage: string,
  aiReply:     string,
  history:     Array<{ role: string; content: string }>,
  userProfile: UserProfile | null,
  deviceId:    string | null
): void {
  const companionName = getCompanionDisplayName(
    userProfile?.companionPersona ?? null,
    userProfile?.companionName ?? null
  );

  // Persist messages to DB
  const msgId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  query(
    `INSERT INTO chat_messages (user_name, role, content, message_id)
     VALUES ($1, 'user', $2, $3), ($1, 'assistant', $4, $5)`,
    [userName, userMessage.slice(0, 8000), `${msgId}:user`, aiReply.slice(0, 8000), `${msgId}:assistant`]
  ).catch((err: unknown) => logger.warn({ err }, "[chatHandlerCore] chat_messages insert failed"));

  // Broadcast to other devices
  broadcastToUser(userName, "chat_sync", {
    role:          "assistant",
    content:       aiReply,
    messageId:     msgId,
    createdAt:     new Date().toISOString(),
    senderDeviceId: deviceId ?? null,
  });

  broadcastToUser(userName, "speak_sync", {
    text:         aiReply,
    messageId:    msgId,
    initiated_by: deviceId ?? null,
  });

  // Save conversation memory summary every 4 turns
  const updatedHistory = [
    ...history,
    { role: "user",      content: userMessage },
    { role: "assistant", content: aiReply },
  ];
  if (updatedHistory.length >= 4 && updatedHistory.length % 4 === 0) {
    import("../../memory/memoryManager.js").then(({ saveMemory }) =>
      saveMemory(updatedHistory, companionName, userName).catch(() => {})
    ).catch(() => {});
  }
}
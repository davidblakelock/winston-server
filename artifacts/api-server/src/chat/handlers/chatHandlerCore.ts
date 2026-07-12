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
import {
  getPendingText,
  setPendingText,
  getLastSmsPayload,
  type SmsPayload,
} from "../../text/textMessageComposer.js";
import { getPendingReservation } from "../../restaurants/restaurantIntelligence.js";
import {
  getPendingEmailReply,
  getPendingMeetingRequests,
} from "../../email/emailMeetingManager.js";
import { getPendingDelete } from "../../google/calendarWriter.js";
import { broadcastToUser } from "../../reminders/sseStore.js";
import { searchContacts } from "../../google/contacts.js";
import { handleText } from "./textHandler.js";
import { handleEmailCalendar } from "./emailCalendarHandler.js";
import { handleReservation, type ReservationPayload } from "./reservationHandler.js";
import { fetchAndSummarizeEmails, trashEmail, archiveEmail, markEmailRead } from "../../google/gmail.js";

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
  | "make_reservation"
  | "send_sms"
  | "make_call"
  | "navigate"
  | "update_calendar"
  | "check_email"
  | "email_action";

export interface ClaudeAction {
  type: ActionType;
  listName?: string | null;
  itemText?: string | null;
  reminderTime?: string | null;
  restaurantName?: string | null;
  recipientName?: string | null;
  smsBody?: string | null;
  phone?: string | null;
  navigationTarget?: string | null;
  calendarIntent?: "read" | "create" | "modify" | "delete" | null;
  emailAction?: "trash" | "archive" | "markRead" | null;
  gmailId?: string | null;
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
  smsPayload?: SmsPayload;
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

PERSONA NAME:
Your name is __COMPANION__. If your name is M.A.C.C., it is pronounced "MACC" (like the name "Mac") — never spell it out as letters. If the user says "Hey MACC" that is correct.

CONVERSATION:
You remember context from this conversation and weave it in naturally when relevant. Pay attention. Connect things when natural. Don't volunteer profile facts unprompted — but use them when genuinely relevant.

LISTS:
The list blocks in your context show the exact current lists pulled live from the database. Use the exact list name shown in those blocks.

At the end of EVERY response append exactly one action tag on a new line. No exceptions. Never say you need a tool to manage lists:

[ACTION:add_list_item|list=<exact list name>|items=<comma separated>] — adding to any list
[ACTION:add_todo|task=<task>] — plain to-do with no time
[ACTION:add_reminder|task=<task>|time=<ISO 8601 with tz offset>] — timed reminder only
[ACTION:add_todo_with_reminder|task=<task>|time=<ISO 8601 with tz offset>] — to-do with time
[ACTION:send_sms|recipient=<name>] — text message
[ACTION:make_call|recipient=<name>] — phone call
[ACTION:navigate|target=<place>] — directions
[ACTION:update_calendar|intent=<read|create|modify|delete>] — calendar
[ACTION:check_email] — email
[ACTION:make_reservation|restaurant=<name>] — reservation
[ACTION:none] — weather, sports, news, markets, general questions

TEXT MESSAGES:
You can COMPOSE text messages for __USER__ but you CANNOT send them. You have zero ability to send any message or touch __USER__'s phone. Draft the message, read it back, and when __USER__ confirms, the app will open the Messages app with the text pre-filled. NEVER claim to have sent a message.

REMINDERS vs CALENDAR:
- REMINDERS: "remind me to", "set a reminder", "don't let me forget" → push notification system
- GOOGLE CALENDAR: Only when __USER__ explicitly says "add to my calendar", "schedule an appointment"
- IF AMBIGUOUS: Ask warmly which they want

BILLS:
Winston only tracks bills that require MANUAL payment. Extract name, due day of month, and optional amount.

GUIDING PRINCIPLE:
You are a knowledgeable, opinionated, genuinely helpful advisor. Be bold. Be specific. Answer questions directly — weather, sports, markets, news — just answer naturally from your knowledge.`;

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

function normalizeListName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*list\s*$/i, "")
    .replace(/to[\s-]do/i, "to do")
    .trim() || "to do";
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
      isTextFlowActive:     true,
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
    const EMAIL_REPLY_ACCEPT = /^(yes|yeah|sure|go ahead|do it|sounds good|draft it|let's do it)[\s.!]*$/i;
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
      isEmailReplyFlowActive: true,
      isEmailReplyAccepted:   EMAIL_REPLY_ACCEPT.test(message.trim()),
      pendingMeetingRequests: pendingMeetingReqs,
      pendingEmailReply,
      userProfile,
      log,
    });
    if (emailResult.hardcodedResponse) {
      if (emailResult.emailPayload) {
        broadcastToUser(sessionUserName, "email-compose", { type: "email_compose", ...emailResult.emailPayload });
      }
      runPostProcessing(sessionUserName, message, emailResult.hardcodedResponse, history, userProfile, deviceId);
      return { reply: emailResult.hardcodedResponse, action: { type: "none" } };
    }
    dynamicPrompt += emailResult.contextBlock;
  }

  // ── Build messages array ─────────────────────────────────────────────────────
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: message },
  ];

  // ── Primary Claude call — plain natural language response ───────────────────
  const systemBlocks = buildSystemBlocks(stableSystem, dynamicPrompt);
  log.info({ fullSystem: (stableSystem + dynamicPrompt).slice(0, 2000) }, "[chatHandlerCore] Full system prompt");
  const primaryResponse = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 1024,
    system:     systemBlocks as Anthropic.TextBlockParam[],
    tools:      [{ type: "web_search_20250305" as const, name: "web_search" }],
    messages,
  });

  const claudeReply = primaryResponse.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();

  if (!claudeReply) {
    const fallback = "Sorry, I had trouble with that. Can you try again?";
    runPostProcessing(sessionUserName, message, fallback, history, userProfile, deviceId);
    return { reply: fallback, action: { type: "none" } };
  }

  log.info({ replyPreview: claudeReply.slice(0, 80) }, "[chatHandlerCore] Reply received");

  // ── Action tag parsing — extracted from Claude's reply ───────────────────
  const tagMatch  = claudeReply.match(/\[ACTION:([^\]]+)\][\s]*$/);
  let finalReply  = claudeReply.replace(/\n?\[ACTION:[^\]]+\]/g, "").trim();

  let action: ClaudeAction = { type: "none" };
  if (tagMatch) {
    const tagContent = tagMatch[1];
    const parts: Record<string, string> = {};
    tagContent.split("|").forEach((p) => {
      const eq = p.indexOf("=");
      if (eq === -1) parts["_type"] = p;
      else { parts["_type"] = parts["_type"] || p.slice(0, eq); parts[p.slice(0, eq)] = p.slice(eq + 1); }
    });
    const tagType = parts["_type"] ?? "none";
    switch (tagType) {
      case "add_list_item":
        action = { type: "add_todo", listName: parts.list ?? "", itemText: parts.items ?? "" };
        break;
      case "add_todo":
        action = { type: "add_todo", listName: "reminders", itemText: parts.task ?? "" };
        break;
      case "add_reminder":
        action = { type: "add_reminder", itemText: parts.task ?? "", reminderTime: parts.time ?? null };
        break;
      case "add_todo_with_reminder":
        action = { type: "add_todo_with_reminder", itemText: parts.task ?? "", reminderTime: parts.time ?? null };
        break;
      case "send_sms":
        action = { type: "send_sms", recipientName: parts.recipient ?? "" };
        break;
      case "make_call":
        action = { type: "make_call", recipientName: parts.recipient ?? "" };
        break;
      case "navigate":
        action = { type: "navigate", navigationTarget: parts.target ?? "" };
        break;
      case "update_calendar":
        action = { type: "update_calendar", calendarIntent: (parts.intent ?? "read") as "read"|"create"|"modify"|"delete" };
        break;
      case "check_email":
        action = { type: "check_email" };
        break;
      case "email_action":
        action = {
          type: "email_action",
          emailAction: (parts.action ?? null) as "trash" | "archive" | "markRead" | null,
          gmailId: parts.gmailId ?? null,
        };
        break;
      case "make_reservation":
        action = { type: "make_reservation", restaurantName: parts.restaurant ?? "" };
        break;
    }
  }
  log.info({ actionType: action.type, tag: tagMatch?.[1] ?? "none" }, "[chatHandlerCore] Action parsed");

  // ── Execute action ───────────────────────────────────────────────────────────
  let smsPayload:         SmsPayload | undefined          = undefined;
  let reservationPayload: ReservationPayload | undefined  = undefined;
  let navigationUrl:      string | undefined              = undefined;

  switch (action.type) {

    case "none":
      break;

    // ── add_todo ──────────────────────────────────────────────────────────────
    case "add_todo": {
      const listName = requestContext?.trim() || action.listName?.trim() || "";
      const items    = (action.itemText ?? "").split(",").map((s) => s.trim()).filter(Boolean);

      if (!listName || listName === "to do" || listName === "reminders") {
        // Plain to-do — write to reminders table with no fire_at
        for (const item of items) {
          try {
            await createReminder({ userName: sessionUserName, reminderText: item, fireAt: null as any, timezone });
            log.info({ item }, "[chatHandlerCore] To-do added to reminders");
          } catch (err) {
            log.warn({ err }, "[chatHandlerCore] To-do add failed");
          }
        }
      } else {
        if (items.length > 0) {
          try {
            const inserted = await addItems(listName, items, sessionUserName);
            if (inserted.length > 0) batchCategorizeAndUpdateItems(inserted).catch(() => {});
            await syncListItemToConnections(listName, items, sessionUserName).catch(() => {});
            log.info({ listName, items }, "[chatHandlerCore] List items added");
          } catch (err) {
            log.warn({ err }, "[chatHandlerCore] addItems failed");
          }
        }
      }
      break;
    }

    // ── add_reminder ──────────────────────────────────────────────────────────
    case "add_reminder": {
      const itemText = action.itemText?.trim() ?? "";
      if (itemText && action.reminderTime) {
        try {
          const fireAt = new Date(action.reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({ userName: sessionUserName, reminderText: itemText, fireAt, timezone });
            log.info({ itemText, fireAt }, "[chatHandlerCore] Reminder created");
          }
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] createReminder failed");
        }
      }
      break;
    }

    // ── add_todo_with_reminder ────────────────────────────────────────────────
    case "add_todo_with_reminder": {
      const listName = normalizeListName(action.listName?.trim() || "to do");
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
          log.warn({ err }, "[chatHandlerCore] add_todo_with_reminder list failed");
        }
      }
      if (itemText && action.reminderTime) {
        try {
          const fireAt = new Date(action.reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({ userName: sessionUserName, reminderText: itemText, fireAt, timezone });
            log.info({ listName, itemText, fireAt }, "[chatHandlerCore] add_todo_with_reminder done");
          }
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] add_todo_with_reminder reminder failed");
        }
      }
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
        const resReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 300,
          system:     buildSystemBlocks(stableSystem, dynamicPrompt + resResult.contextBlock) as Anthropic.TextBlockParam[],
          messages,
        });
        const resText = resReply.content[0]?.type === "text" ? resReply.content[0].text.trim() : "";
        if (resText) finalReply = resText;
        reservationPayload = resResult.reservationPayload;
      }
      break;
    }

    // ── send_sms ──────────────────────────────────────────────────────────────
    case "send_sms": {
      const recipientName = action.recipientName?.trim() ?? "";
      if (recipientName) {
        // Look up contact phone number
        const searchResult = await searchContacts(recipientName, sessionUserName)
          .catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
        const contact = searchResult.contacts[0] ?? null;
        const phone   = contact?.phone ?? null;
        const name    = contact?.name ?? recipientName;
        const tone    = "casual" as const;

        if (action.smsBody) {
          // Claude already composed a body — go straight to confirmation
          setPendingText(sessionUserName, {
            phase:          "awaiting_confirmation",
            recipientName:  name,
            recipientPhone: phone,
            tone,
            composedBody:   action.smsBody,
          });
          finalReply =
            `Here's what I've got for ${name}:\n\n"${action.smsBody}"\n\n` +
            `Does that work? Say yes and I'll hand it off to your Messages app so you can tap Send.`;
        } else {
          // Ask what to say
          setPendingText(sessionUserName, {
            phase:          "awaiting_intent",
            recipientName:  name,
            recipientPhone: phone,
            tone,
          });
          finalReply = `What would you like to say to ${name}?`;
        }
        log.info({ recipientName: name, hasPhone: !!phone }, "[chatHandlerCore] SMS flow started");
      }
      break;
    }

    // ── make_call ─────────────────────────────────────────────────────────────
    case "make_call": {
      const phone = action.phone?.trim();
      if (phone) {
        navigationUrl = `tel:${phone.replace(/[^\d+]/g, "")}`;
      } else if (action.recipientName) {
        const searchResult = await searchContacts(action.recipientName, sessionUserName)
          .catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
        const contact = searchResult.contacts[0];
        if (contact?.phone) {
          navigationUrl = `tel:${contact.phone.replace(/[^\d+]/g, "")}`;
        }
      }
      log.info({ recipientName: action.recipientName, navigationUrl }, "[chatHandlerCore] make_call");
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

    // ── check_email ───────────────────────────────────────────────────────────
    case "check_email": {
      log.info("[chatHandlerCore] check_email: fetching emails via handleEmailCalendar");
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
        log.info({ contextBlockLength: emailResult.contextBlock.length }, "[chatHandlerCore] check_email: running Haiku call with email context");
        const emailReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 600,
          system:     buildSystemBlocks(stableSystem, emailResult.contextBlock) as Anthropic.TextBlockParam[],
          messages,
        });
        const emailText = emailReply.content[0]?.type === "text" ? emailReply.content[0].text.trim() : "";
        log.info({ emailTextLength: emailText.length, preview: emailText.slice(0, 80) }, "[chatHandlerCore] check_email: Haiku reply received");
        if (emailText) finalReply = emailText;
      }
      if (emailResult.emailPayload) {
        broadcastToUser(sessionUserName, "email-compose", { type: "email_compose", ...emailResult.emailPayload });
      }
      break;
    }

    // ── email_action ─────────────────────────────────────────────────────────
    case "email_action": {
      if (action.gmailId && action.emailAction) {
        const doneAction = action.emailAction === "markRead"
          ? (userProfile?.emailDoneAction ?? "mark_read")
          : action.emailAction;

        if (doneAction === "trash") {
          await trashEmail(action.gmailId, sessionUserName).catch(() => {});
          log.info({ gmailId: action.gmailId }, "[chatHandlerCore] Email trashed");
        } else if (doneAction === "archive") {
          await archiveEmail(action.gmailId, sessionUserName).catch(() => {});
          log.info({ gmailId: action.gmailId }, "[chatHandlerCore] Email archived");
        } else {
          await markEmailRead(action.gmailId, sessionUserName).catch(() => {});
          if (userProfile?.emailDoneAction === "archive") {
            await archiveEmail(action.gmailId, sessionUserName).catch(() => {});
          }
          log.info({ gmailId: action.gmailId }, "[chatHandlerCore] Email marked read");
        }
      }
      break;
    }

    // ── update_calendar ───────────────────────────────────────────────────────
    case "update_calendar": {
      const intent      = action.calendarIntent ?? "read";
      const isRead      = intent === "read";
      const isCreate    = intent === "create";
      const isModify    = intent === "modify";
      const isDelete    = intent === "delete";
      const pd          = getPendingDelete(sessionUserName);
      const CONFIRM_PAT = /^(yes|yeah|yep|sure|go ahead|do it|confirmed?|ok|okay|correct|absolutely)[\s.!]*$/i;
      const CANCEL_PAT  = /^(no|nope|nah|never mind|cancel|keep it|forget it)[\s.!]*$/i;
      const isDeleteConfirm = !!pd && CONFIRM_PAT.test(message.trim());
      const isDeleteCancel  = !!pd && CANCEL_PAT.test(message.trim());

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
        isDeleteConfirm,
        isDeleteCancel,
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
        const calReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 400,
          system:     buildSystemBlocks(stableSystem, dynamicPrompt + calResult.contextBlock) as Anthropic.TextBlockParam[],
          messages,
        });
        const calText = calReply.content[0]?.type === "text" ? calReply.content[0].text.trim() : "";
        if (calText) finalReply = calText;
      }
      break;
    }

  }

  // ── Post-processing ──────────────────────────────────────────────────────────
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

  const msgId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  query(
    `INSERT INTO chat_messages (user_name, role, content, message_id)
     VALUES ($1, 'user', $2, $3), ($1, 'assistant', $4, $5)`,
    [userName, userMessage.slice(0, 8000), `${msgId}:user`, aiReply.slice(0, 8000), `${msgId}:assistant`]
  ).catch((err: unknown) => logger.warn({ err }, "[chatHandlerCore] chat_messages insert failed"));

  broadcastToUser(userName, "chat_sync", {
    role:           "assistant",
    content:        aiReply,
    messageId:      msgId,
    createdAt:      new Date().toISOString(),
    senderDeviceId: deviceId ?? null,
  });

  broadcastToUser(userName, "speak_sync", {
    text:         aiReply,
    messageId:    msgId,
    initiated_by: deviceId ?? null,
  });

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
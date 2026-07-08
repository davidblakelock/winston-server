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
  getProfilePlaces,
  formatProfileForContext,
} from "../../profile/profileManager.js";
import { getPeople, type KeyPerson } from "../../people/peopleManager.js";
import {
  getRecentMemories,
  formatMemoriesForContext,
  extractAndSaveConversationFacts,
  type ConversationMemory,
} from "../../memory/memoryManager.js";
import {
  getBriefingPreferences,
  buildBriefingPrefsBlock,
  type BriefingPreference,
} from "../../briefingPreferences/briefingPreferencesManager.js";
import { getCurrentDateTimeBlock } from "../getCurrentDateTimeBlock.js";
import {
  getAllLists,
  addItems,
  syncListItemToConnections,
} from "../../lists/listManager.js";
import { createReminder } from "../../reminders/reminderManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../../google/calendar.js";
import { getCachedWeather, type CachedWeather } from "../../weather/weatherCache.js";
import { fetchMarkets, buildMarketsBlock } from "../../markets/marketsManager.js";
import { saveMydayEntry } from "../../myday/mydayManager.js";
import { saveLifeCapture } from "../../lifeCaptures/lifeCapturesManager.js";
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
  type DetectedMeetingRequest,
  type PendingEmailReply,
} from "../../email/emailMeetingManager.js";
import { findConnectionByLabel } from "../../connect/connectManager.js";
import { handleText, type TextResult } from "./textHandler.js";
import { handleEmailCalendar, type EmailCalendarResult } from "./emailCalendarHandler.js";
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
  | "save_to_attic"
  | "search_contact"
  | "save_contact"
  | "make_reservation"
  | "send_sms"
  | "navigate"
  | "get_weather"
  | "get_markets"
  | "update_calendar";

export interface ClaudeAction {
  type: ActionType;
  // add_todo
  listName?: string | null;
  itemText?: string | null;
  // add_reminder
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
  // send_sms
  recipientName?: string | null;
  smsBody?: string | null;
  // navigate
  navigationTarget?: string | null;
  // update_calendar
  calendarIntent?: "read" | "create" | "modify" | "delete" | null;
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
    info:  (obj: object, msg?: string) => void;
    warn:  (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
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

// Fallback system prompt when onboarding is incomplete (mirrors chat.ts local version)
const BASE_SYSTEM_PROMPT_TEMPLATE = `You are __COMPANION__, __USER__'s personal AI companion.

MEMORY AND CONTEXT:
You remember context from this conversation and weave it in naturally when relevant — the way a friend would. Not mechanically at every turn, but you don't pretend the conversation started thirty seconds ago either. Pay attention. Connect things when it's natural to do so. Don't volunteer profile facts unprompted — but if something from earlier is genuinely relevant to right now, use it.

LISTS — STRICT RULE: You have no independent knowledge of what is on __USER__'s lists. If you are asked about a list and no [List …] context block appears above in this prompt, you MUST NOT guess or invent any items. Say exactly: "I had trouble reading your list — try checking the list screen directly." This applies even if you think you remember items from earlier in the conversation.

TEXT MESSAGES — ABSOLUTE HONESTY RULE: You can COMPOSE text messages for __USER__, but you ABSOLUTELY CANNOT send them. You have zero ability to send any message, open any app, or touch __USER__'s phone in any way. What you actually do: draft the message, read it back, and when __USER__ confirms, the app will ATTEMPT to open his Messages app with the text pre-filled — but you have no control over whether that succeeds. NEVER claim to have sent a message.

REMINDERS vs CALENDAR — CRITICAL DISTINCTION:
• REMINDERS (push notifications): When __USER__ says "remind me to", "set a reminder", "don't let me forget" — this goes into the push notification reminder system.
• GOOGLE CALENDAR: Only when __USER__ explicitly says "add to my calendar", "schedule an appointment", "book a meeting".
• IF AMBIGUOUS: Ask warmly: "Would you like me to set a reminder for that, or add it to your Google Calendar?"

GUIDING PRINCIPLE:
You are a knowledgeable, opinionated, genuinely helpful advisor. Be bold. Be specific. When you know something — say it directly, without hedging.`;

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
    BASE_SYSTEM_PROMPT_TEMPLATE
      .replace(/__USER__/g, user)
      .replace(/__COMPANION__/g, companion)
  );
}

function formatWeatherBlock(w: CachedWeather): string {
  return (
    `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition}` +
    ` — high ${w.high}°F / low ${w.low}°F` +
    ` | ${w.precipChance}% precip | humidity ${w.humidity}%`
  );
}

function buildListsBlock(allLists: Record<string, string[]>): string {
  let block = "";
  for (const [listName, items] of Object.entries(allLists)) {
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

// ── Action schema injected into every system prompt ───────────────────────────

const ACTION_SCHEMA_BLOCK = `

[RESPONSE FORMAT — REQUIRED]
Always respond with valid JSON only. No markdown, no preamble:
{
  "reply": "Your natural language message to the user",
  "action": {
    "type": "<action type from list below>",
    ... action-specific fields ...
  }
}

AVAILABLE ACTION TYPES:
- "none"           — General conversation, answering questions, giving advice
- "add_todo"       → listName (string), itemText (comma-separated items)
- "add_reminder"   → itemText (what to remind), reminderTime (ISO 8601), forContact (first name, optional)
- "save_to_attic"  → content (the thing to save to memory)
- "search_contact" → searchQuery (person's name to look up)
- "save_contact"   → contactName, contactPhone (or null), contactEmail (or null), saveDestination ("my_people"|"service_providers"|"curated")
- "make_reservation" → restaurantName
- "send_sms"       → recipientName, smsBody (or null to ask user for content)
- "navigate"       → navigationTarget (address or place name)
- "get_weather"    — Uses user's city from profile. No extra params.
- "get_markets"    — Current market data. No extra params.
- "update_calendar" → calendarIntent ("read"|"create"|"modify"|"delete")

RULES:
- Use "add_todo" whenever the user adds anything to any list — always emit this action.
- reminderTime must be ISO 8601 with timezone offset; infer the date if not explicit.
- For ordinary conversation, Q&A, or explanations, use "none".
- Your reply should sound natural — acknowledge what you're doing inline ("Adding that now.", "I'll remind you at 3pm.", "Let me check the weather.").`;

// ── JSON extraction with fallback strategies ──────────────────────────────────

function parseClaudeOutput(raw: string): ClaudeOutput | null {
  // Strategy 1: entire response is JSON
  try {
    const parsed = JSON.parse(raw.trim()) as ClaudeOutput;
    if (parsed.reply && parsed.action?.type) return parsed;
  } catch { /* fall through */ }

  // Strategy 2: ```json block
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as ClaudeOutput;
      if (parsed.reply && parsed.action?.type) return parsed;
    } catch { /* fall through */ }
  }

  // Strategy 3: first { to last }
  const braceStart = raw.indexOf("{");
  const braceEnd   = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(raw.slice(braceStart, braceEnd + 1)) as ClaudeOutput;
      if (parsed.reply && parsed.action?.type) return parsed;
    } catch { /* fall through */ }
  }

  // Strategy 4: extract reply field and default action to none
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
     WHERE user_name = $1 ORDER BY created_at DESC LIMIT $2`,
    [userName, ACTIVE_CONTEXT_LIMIT]
  );
  return rows.reverse();
}

// Strip context injection blocks from prior assistant turns to avoid stale data
// bleeding into the prompt on repeated lookups (contacts, weather, etc.).
const STALE_CONTEXT_PATTERN =
  /\[(?:Contact(?:s)? Found|Search Results|Weather|Markets|Calendar)[^\]]*\][\s\S]*?(?=\n\[|\n\n[A-Z]|$)/gi;

function scrubStaleContext(
  history: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  return history.map((m) => {
    if (m.role !== "assistant") return m;
    const scrubbed = m.content.replace(STALE_CONTEXT_PATTERN, "").trim();
    return scrubbed.length > 0 ? { ...m, content: scrubbed } : m;
  });
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
    memories,
    profileItems,
    keyPeople,
    briefingPrefs,
    allLists,
    pendingReminderRows,
    todayEvents,
    dbHistory,
  ] = await Promise.all([
    getProfile(sessionUserName).catch(() => null),
    getRecentMemories(7).catch((): ConversationMemory[] => []),
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

  // Use DB-hydrated history if client sent empty array
  if (dbHistory !== null && history.length === 0) {
    history = dbHistory;
  }
  history = scrubStaleContext(history);

  // ── Check for active multi-turn flows ───────────────────────────────────────
  const pendingText        = getPendingText(sessionUserName);
  const pendingReservation = getPendingReservation(sessionUserName);
  const pendingEmailReply  = getPendingEmailReply(sessionUserName);
  const pendingMeetingReqs = getPendingMeetingRequests(sessionUserName);

  // ── Build stable system prompt (persona + profile — cached by Anthropic) ────
  const displayName = getCompanionDisplayName(
    userProfile?.companionPersona ?? null,
    userProfile?.companionName ?? null
  );
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

  // ── Build dynamic system prompt (changes every request) ─────────────────────
  const memoryBlock       = formatMemoriesForContext(memories);
  const profileItemsBlock = formatProfileForContext(profileItems, sessionUserName);
  const prefsBlock        = buildBriefingPrefsBlock(briefingPrefs, sessionUserName);

  let dynamicPrompt =
    getCurrentDateTimeBlock(timezone) +
    memoryBlock +
    profileItemsBlock +
    prefsBlock +
    buildListsBlock(allLists) +
    buildRemindersBlock(pendingReminderRows, timezone) +
    buildCalendarBlock(todayEvents, timezone);

  if (requestContext) {
    dynamicPrompt += `\n\n[Active Screen: ${requestContext} list]\nWhen adding items without specifying a list, use "${requestContext}".`;
  }

  // ── Pre-flight: handle active multi-turn flows ───────────────────────────────
  // SMS compose in progress — check before calling Claude
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
      runPostProcessing(sessionUserName, message, textResult.hardcodedResponse, history, userProfile);
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
      runPostProcessing(sessionUserName, message, resResult.hardcodedResponse, history, userProfile);
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
      memoryBlock,
      isDinnerTonightQuery: false,
      isEmailRequest:       true,
      isCalendarRequest:    false,
      isCalendarWriteOp:    false,
      isDeleteConfirm:      false,
      isDeleteCancel:       false,
      isCalendarCreate:     false,
      isCalendarModify:     false,
      isCalendarDelete:     false,
      isEmailReplyFlowActive: true,
      isEmailReplyAccepted:   /\byes\b|\bsend\b|\bsounds good\b|\bthat works\b/i.test(message),
      pendingMeetingRequests: pendingMeetingReqs,
      pendingEmailReply,
      userProfile,
      log,
    });
    if (emailResult.hardcodedResponse) {
      runPostProcessing(sessionUserName, message, emailResult.hardcodedResponse, history, userProfile);
      return {
        reply:  emailResult.hardcodedResponse,
        action: { type: "none" },
      };
    }
    dynamicPrompt += emailResult.contextBlock;
  }

  // ── Add action schema to dynamic prompt ─────────────────────────────────────
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
    messages,
  });

  const rawText =
    primaryResponse.content[0]?.type === "text" ? primaryResponse.content[0].text : "";

  const parsed = parseClaudeOutput(rawText);
  if (!parsed) {
    log.warn({ rawText: rawText.slice(0, 500) }, "[chatHandlerCore] Failed to parse Claude JSON output");
    const fallbackReply = rawText.trim() || "Sorry, I had trouble with that. Can you try again?";
    runPostProcessing(sessionUserName, message, fallbackReply, history, userProfile);
    return { reply: fallbackReply, action: { type: "none" } };
  }

  const { reply: claudeReply, action } = parsed;
  log.info({ actionType: action.type, user: sessionUserName }, "[chatHandlerCore] Action resolved");

  // ── Execute action ───────────────────────────────────────────────────────────
  let finalReply      = claudeReply;
  let smsPayload:      NewChatResponse["smsPayload"]         = undefined;
  let reservationPayload: NewChatResponse["reservationPayload"] = undefined;
  let navigationUrl:   string | undefined                    = undefined;

  switch (action.type) {

    case "none":
      break;

    // ── add_todo ──────────────────────────────────────────────────────────────
    case "add_todo": {
      const listName = action.listName?.trim() || "to do";
      const rawText  = action.itemText ?? "";
      const items    = rawText.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) {
        try {
          await addItems(listName, items, sessionUserName);
          await syncListItemToConnections(listName, items, sessionUserName).catch(() => {});
          log.info({ listName, items, user: sessionUserName }, "[chatHandlerCore] Items added to list");
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
      const forContact   = action.forContact?.trim() ?? null;

      if (itemText && reminderTime) {
        try {
          const fireAt = new Date(reminderTime);
          if (!isNaN(fireAt.getTime())) {
            await createReminder({
              userName:     sessionUserName,
              reminderText: itemText,
              fireAt,
              timezone,
              ...(forContact ? { forContact } : {}),
            });
            log.info({ itemText, fireAt, forContact, user: sessionUserName }, "[chatHandlerCore] Reminder created");

            // Winston Connect — if reminder is for another user, notify them too
            if (forContact) {
              const connection = await findConnectionByLabel(sessionUserName, forContact).catch(() => null);
              if (connection?.recipientUserName) {
                await createReminder({
                  userName:     connection.recipientUserName,
                  reminderText: `A message from ${connection.senderLabel}: ${itemText}`,
                  fireAt,
                  timezone,
                }).catch(() => {});
                log.info({ forContact, recipientUser: connection.recipientUserName }, "[chatHandlerCore] Winston Connect reminder mirrored");
              }
            }
          }
        } catch (err) {
          log.warn({ err, itemText }, "[chatHandlerCore] createReminder failed");
        }
      }
      break;
    }

    // ── save_to_attic ─────────────────────────────────────────────────────────
    case "save_to_attic": {
      const content = action.content?.trim() ?? message.trim();
      try {
        await saveMydayEntry(sessionUserName, content);
        await saveLifeCapture(sessionUserName, content, "observation").catch(() => {});
        log.info({ user: sessionUserName }, "[chatHandlerCore] Saved to attic");
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] save_to_attic failed");
      }
      break;
    }

    // ── search_contact ────────────────────────────────────────────────────────
    case "search_contact": {
      const contactResult = await handleContact({
        message,
        sessionUserName,
        isContactRequest:        true,
        isCompoundContactAndSave: /\b(?:and\s+)?(?:save|add)\b/i.test(message),
        isSaveContactRequest:    false,
        isGoogleContactWrite:    false,
        history,
        userProfile,
        log,
      });

      if (contactResult.contextBlock) {
        // Second pass: let Claude generate a reply with the search results in context
        const enrichedDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          contactResult.contextBlock +
          `\n\nRespond in plain text — the user asked about a contact and the result is above. Summarize it naturally.`;
        const followUp = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 300,
          system:     buildSystemBlocks(stableSystem, enrichedDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const followUpText = followUp.content[0]?.type === "text" ? followUp.content[0].text.trim() : "";
        if (followUpText) finalReply = followUpText;
      }
      break;
    }

    // ── save_contact ──────────────────────────────────────────────────────────
    case "save_contact": {
      const saveResult = await handleContact({
        message,
        sessionUserName,
        isContactRequest:        false,
        isCompoundContactAndSave: false,
        isSaveContactRequest:    true,
        isGoogleContactWrite:    /google|contacts app/i.test(message),
        history,
        userProfile,
        log,
      });
      if (saveResult.contextBlock) {
        dynamicPrompt += saveResult.contextBlock;
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
        // Second pass: let Claude answer with reservation data in context
        const enrichedDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          resResult.contextBlock +
          `\n\nRespond in plain text — no JSON needed here.`;
        const followUp = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 300,
          system:     buildSystemBlocks(stableSystem, enrichedDynamic) as Anthropic.TextBlockParam[],
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
        isTextFlowActive: true,
        pendingText:      null,
        isSmsRetryRequest:   false,
        isSmsEditAfterSend:  false,
        lastSmsPayload:      null,
        userProfile,
        log,
      });
      if (textResult.hardcodedResponse) {
        finalReply = textResult.hardcodedResponse;
        smsPayload = textResult.smsPayload;
      } else if (textResult.contextBlock) {
        dynamicPrompt += textResult.contextBlock;
        // Let Claude's original reply stand — it was composed knowing this is SMS
      }
      break;
    }

    // ── navigate ──────────────────────────────────────────────────────────────
    case "navigate": {
      const target = action.navigationTarget?.trim();
      if (target) {
        const places = await getProfilePlaces(sessionUserName).catch(
          (): Array<{ name: string; address: string }> => []
        );
        const targetLower = target.toLowerCase();
        const savedPlace = places.find((p) =>
          p.name.toLowerCase().includes(targetLower) || targetLower.includes(p.name.toLowerCase())
        );
        const address = savedPlace?.address ?? target;
        navigationUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
        log.info({ target, address, navigationUrl }, "[chatHandlerCore] Navigation URL built");
      }
      break;
    }

    // ── get_weather ───────────────────────────────────────────────────────────
    case "get_weather": {
      try {
        const city  = userProfile?.city ?? "";
        const lat   = userProfile?.latitude  ?? null;
        const lon   = userProfile?.longitude ?? null;
        const wx    = await getCachedWeather(city, lat, lon);
        const wxBlock = `\n\n[Current Weather]\n${formatWeatherBlock(wx)}`;

        const weatherDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          wxBlock +
          `\n\nRespond in plain text — no JSON. Give a brief, warm weather reply in your companion voice.`;
        const wxReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 200,
          system:     buildSystemBlocks(stableSystem, weatherDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const wxText = wxReply.content[0]?.type === "text" ? wxReply.content[0].text.trim() : "";
        if (wxText) finalReply = wxText;
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] Weather fetch failed — using Claude's reply");
      }
      break;
    }

    // ── get_markets ───────────────────────────────────────────────────────────
    case "get_markets": {
      try {
        const markets      = await fetchMarkets();
        const marketsBlock = buildMarketsBlock(markets);

        const mktDynamic = dynamicPrompt.replace(ACTION_SCHEMA_BLOCK, "") +
          `\n\n${marketsBlock}` +
          `\n\nRespond in plain text — no JSON. Give a brief market update in your companion voice.`;
        const mktReply = await anthropic.messages.create({
          model:      MODEL_HAIKU,
          max_tokens: 250,
          system:     buildSystemBlocks(stableSystem, mktDynamic) as Anthropic.TextBlockParam[],
          messages,
        });
        const mktText = mktReply.content[0]?.type === "text" ? mktReply.content[0].text.trim() : "";
        if (mktText) finalReply = mktText;
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] Markets fetch failed — using Claude's reply");
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
      const isWriteOp   = isCreate || isModify || isDelete;

      const calResult = await handleEmailCalendar({
        message,
        sessionUserName,
        timezone,
        corePrompt,
        memoryBlock,
        isDinnerTonightQuery: /dinner tonight/i.test(message),
        isEmailRequest:       false,
        isCalendarRequest:    isRead,
        isCalendarWriteOp:    isWriteOp,
        isDeleteConfirm:      false,
        isDeleteCancel:       false,
        isCalendarCreate:     isCreate,
        isCalendarModify:     isModify,
        isCalendarDelete:     isDelete,
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
          `\n\nRespond in plain text — no JSON. Answer the user's calendar question directly using the data above.`;
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
  }

  // ── Post-response fire-and-forget ────────────────────────────────────────────
  runPostProcessing(sessionUserName, message, finalReply, history, userProfile);

  return { reply: finalReply, action, smsPayload, reservationPayload, navigationUrl };
}

// ── Post-processing (non-blocking) ────────────────────────────────────────────

function runPostProcessing(
  userName:    string,
  userMessage: string,
  aiReply:     string,
  history:     Array<{ role: string; content: string }>,
  userProfile: UserProfile | null
): void {
  const companionName = getCompanionDisplayName(
    userProfile?.companionPersona ?? null,
    userProfile?.companionName ?? null
  );

  // Save conversation memory
  const updatedHistory = [
    ...history,
    { role: "user",      content: userMessage },
    { role: "assistant", content: aiReply },
  ];

  // Persist message to DB
  query(
    `INSERT INTO chat_messages (user_name, role, content) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [userName, "user", userMessage, "assistant", aiReply]
  ).catch((err: unknown) => logger.warn({ err }, "[chatHandlerCore] chat_messages insert failed"));

  // Extract and save durable personal facts
  extractAndSaveConversationFacts(userMessage, aiReply, userName).catch(() => {});

  // Save memory summary for long conversations
  if (updatedHistory.length >= 4 && updatedHistory.length % 4 === 0) {
    import("../../memory/memoryManager.js").then(({ saveMemory }) =>
      saveMemory(updatedHistory, companionName, userName).catch(() => {})
    ).catch(() => {});
  }
}

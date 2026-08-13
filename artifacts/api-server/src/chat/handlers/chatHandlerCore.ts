import Anthropic from "@anthropic-ai/sdk";
import { query } from "../../db.js";
import { logger } from "../../lib/logger.js";
import { buildSharedCapabilityPrompt } from "../systemPromptShared.js";
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
  claimWinddownReply,
  getTonightMessage,
  saveTonightMessage,
  markFiredToday,
  setWinddownActive,
} from "../../winddown/winddownManager.js";
import { generateOpeningMessage } from "../../winddown/winddownScheduler.js";
import { saveLifeCapture } from "../../lifeCaptures/lifeCapturesManager.js";
import { getStoicForUser } from "../../stoic/stoicManager.js";
import {
  runConnectionEngine,
  applyObservationCorrection,
  getMostRecentShownObservation,
  markObservationAccepted,
  getConnectionById,
  updateConnectionStatus,
  linkObservationToConnection,
  writeGoalConnection,
  GOAL_OFFER_SUFFIX,
  type SourceType,
} from "../../connectionEngine/connectionEngineManager.js";
import { createGoal, linkGoalToObservation, getGoals, getGoalById } from "../../goals/goalsManager.js";
import {
  saveAtticItem,
  getArchiveCandidates,
  archiveAtticItems,
  getPendingAtticCleanup,
  setPendingAtticCleanup,
  DEFAULT_ARCHIVE_THRESHOLD_DAYS,
  type PendingAtticCleanup,
} from "../../attic/atticItemsManager.js";
import { getProactivePicks } from "../../morning/proactiveEventScheduler.js";
import { getCurrentDateTimeBlock } from "../getCurrentDateTimeBlock.js";
import {
  getAllLists,
  addItems,
  batchCategorizeAndUpdateItems,
  syncListItemToConnections,
  getPendingSaveOffers,
  setPendingSaveOffers,
  getListType,
  convertListToChecklist,
  getPendingListTypeConflict,
  setPendingListTypeConflict,
  getPendingListCleanup,
  setPendingListCleanup,
  getListArchiveCandidates,
  archiveListItems,
  DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS,
  type SaveOfferCandidate,
  type PendingListTypeConflict,
} from "../../lists/listManager.js";
import { createReminder, markReminderDone } from "../../reminders/reminderManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../../google/calendar.js";
import {
  getPendingText,
  setPendingText,
  getLastSmsPayload,
  setLastSmsPayload,
  classifyConfirmationIntent,
  classifySmsFollowupIntent,
  composeTextMessage,
  extractInlineIntent,
  detectToneOverride,
  type SmsPayload,
} from "../../text/textMessageComposer.js";
import { getPendingReservation } from "../../restaurants/restaurantIntelligence.js";
import {
  getPendingEmailReply,
  setPendingEmailReply,
  clearPendingEmailReply,
  getPendingMeetingRequests,
  clearPendingMeetingRequests,
  composeEmailReply,
} from "../../email/emailMeetingManager.js";
import { getPendingDelete } from "../../google/calendarWriter.js";
import { broadcastToUser } from "../../reminders/sseStore.js";
import { searchContacts } from "../../google/contacts.js";
import { handleText, sanitizePhone } from "./textHandler.js";
import { handleEmailCalendar } from "./emailCalendarHandler.js";
import { handleReservation, type ReservationPayload } from "./reservationHandler.js";
import { fetchAndSummarizeEmails, trashEmail, archiveEmail, markEmailRead } from "../../google/gmail.js";
import { getTriageSession, setTriageSession, getCurrentTriageEmail, advanceTriageSession } from "../../email/emailTriageSession.js";

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
  | "complete_reminder"
  | "add_todo_with_reminder"
  | "make_reservation"
  | "send_sms"
  | "make_call"
  | "navigate"
  | "update_calendar"
  | "check_email"
  | "email_action"
  | "email_next"
  | "email_reply"
  | "email_send"
  | "email_revise"
  | "email_cancel"
  | "email_compose"
  | "sms_send"
  | "sms_revise"
  | "sms_cancel"
  | "morning_rundown"
  | "local_activity_search"
  | "save_to_attic"
  | "correct_observation"
  | "cleanup_attic"
  | "archive_attic_confirm"
  | "archive_attic_cancel"
  | "cleanup_list"
  | "archive_list_confirm"
  | "archive_list_cancel"
  | "offer_save"
  | "convert_notepad_confirm"
  | "convert_notepad_cancel"
  | "create_goal_from_observation"
  | "reconnect_goal_observation"
  | "make_goal_aspirational_from_observation";

export interface ClaudeAction {
  type: ActionType;
  listName?: string | null;
  itemText?: string | null;
  reminderTime?: string | null;
  reminderId?: number | null;
  /** "weekend" biases local_activity_search toward Fri-Sun picks; "week" (default) is broader. */
  localActivityContext?: "week" | "weekend" | null;
  restaurantName?: string | null;
  recipientName?: string | null;
  smsBody?: string | null;
  phone?: string | null;
  navigationTarget?: string | null;
  calendarIntent?: "read" | "create" | "modify" | "delete" | null;
  emailAction?: "trash" | "archive" | "markRead" | null;
  gmailId?: string | null;
  feedback?: string | null;
  /** Exact text to send verbatim, overriding the stored draft — used when the
   *  user says "send that word for word" / "use exactly what I typed" for
   *  either email_send or sms_send. */
  body?: string | null;
  correctionType?: "dismiss" | "reject" | "elevate" | "forget" | null;
  goalName?: string | null;
  excludeIndexes?: string | null;
  notes?:          string | null;
  url?:            string | null;
  offers?:         string | null;
  offerIndex?:     number | null;
  fromConflict?:   boolean | null;
  listNameForCleanup?: string | null; // distinct from the existing `listName`
  // field used elsewhere in this interface for adds, to avoid ambiguity
  // about which flow a given action's listName refers to
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
  /** True when this message was generated by the client-side winddownRequest
   *  flag (routes/chat.ts rewrites it to "good evening") — i.e. it's the
   *  message that OPENS tonight's check-in, not a reply to it. */
  isWinddownOpener?: boolean;
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
  messageId?: string;
  emailPayload?: {
    to: string;
    recipientName: string;
    subject: string;
    body: string;
    mailtoUri: string;
  };
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
    buildSharedCapabilityPrompt({ userName: user, companionName: companion, city: null })
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
  rows: Array<{ id: number; reminder_text: string; fire_at: string; for_contact: string | null }>,
  timezone: string
): string {
  if (rows.length === 0) return "";
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  return `\n\n[Active Reminders — ${rows.length} pending — indexed for reference]\n` +
    rows.map((r, i) =>
      `${i + 1}. [id=${r.id}] ${r.reminder_text}${r.for_contact ? ` (for ${r.for_contact})` : ""} — ${fmt(r.fire_at)}`
    ).join("\n") +
    `\nIf the user wants to mark one done or drop it, use the id shown above — never retype the text.`;
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
       AND content NOT LIKE '[Email Card —%'
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
    isWinddownOpener = false,
    log,
  } = req;

  // ── Email-triage fast path ───────────────────────────────────────────────────
  // A bare "trash it" / "archive it" / "mark it read" / "next" mid-triage was
  // paying for the full pipeline — the always-on context Promise.all (profile,
  // lists, calendar, reminders, history) plus a full Sonnet call with the
  // entire system prompt — just to resolve a three-way deterministic choice.
  // Observed live at 3-5s per step. These commands are only unambiguous
  // because a triage session is already open (nothing else is plausibly being
  // asked), so this only fires in that narrow window; anything that doesn't
  // tightly match, or any other flow being mid-turn, falls through to the full
  // pipeline unchanged — never worse than before, just not faster.
  const fastTriageSession = getTriageSession(sessionUserName);
  if (fastTriageSession && getPendingEmailReply(sessionUserName) === null) {
    const trimmed = message.trim().toLowerCase().replace(/[.!]+$/, "");
    const TRASH_RE   = /^(trash|trash it|trash that|delete|delete it|delete that|get rid of it|remove it)$/;
    const ARCHIVE_RE = /^(archive|archive it|archive that)$/;
    const DONE_RE     = /^(mark (it |this )?(as )?read|mark read|done|keep it|keep|leave it|leave it alone|skip|skip it|skip that|next|next one|next email|move on)$/;

    let triageAction: "trash" | "archive" | "markRead" | null = null;
    if (TRASH_RE.test(trimmed)) triageAction = "trash";
    else if (ARCHIVE_RE.test(trimmed)) triageAction = "archive";
    else if (DONE_RE.test(trimmed)) triageAction = "markRead";

    const currentEmail = fastTriageSession.emails[fastTriageSession.currentIndex];
    if (triageAction && currentEmail) {
      const fastProfile = await getProfile(sessionUserName).catch(() => null);
      const doneAction = triageAction === "markRead"
        ? (fastProfile?.emailDoneAction ?? "mark_read")
        : triageAction;

      if (doneAction === "trash") {
        await trashEmail(currentEmail.gmailId, sessionUserName).catch(() => {});
      } else if (doneAction === "archive") {
        await archiveEmail(currentEmail.gmailId, sessionUserName).catch(() => {});
      } else {
        await markEmailRead(currentEmail.gmailId, sessionUserName).catch(() => {});
        if (fastProfile?.emailDoneAction === "archive") {
          await archiveEmail(currentEmail.gmailId, sessionUserName).catch(() => {});
        }
      }
      log.info({ gmailId: currentEmail.gmailId, triageAction, doneAction }, "[chatHandlerCore] Triage fast path");

      let fastReply: string;
      if (triageAction === "trash") fastReply = "Trashed.";
      else if (triageAction === "archive") fastReply = "Archived.";
      else fastReply = "Got it.";

      const nextEmail = advanceTriageSession(sessionUserName);
      if (nextEmail) {
        const session = getTriageSession(sessionUserName);
        broadcastToUser(sessionUserName, "email_card", {
          type: "email_card",
          gmailId: nextEmail.gmailId,
          from: nextEmail.from,
          subject: nextEmail.subject,
          snippet: nextEmail.snippet,
          index: (session?.currentIndex ?? 0) + 1,
          total: session ? session.emails.length : 0,
        });
      } else {
        fastReply = "You're all caught up — inbox handled!";
        broadcastToUser(sessionUserName, "email_done", {
          type: "email_done",
          text: fastReply,
        });
      }

      const fastMessageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      runPostProcessing(sessionUserName, message, fastReply, req.history.slice(-ACTIVE_CONTEXT_LIMIT), fastProfile, deviceId, fastMessageId);
      return {
        reply: fastReply,
        action: { type: "email_action", gmailId: currentEmail.gmailId, emailAction: triageAction },
        messageId: fastMessageId,
      };
    }
  }

  // ── Wind-down opener short-circuit ──────────────────────────────────────────
  // The message that OPENS tonight's check-in (isWinddownOpener from the web's
  // winddownRequest flag, or the literal "Evening Check In" text the native
  // app's background notification handler posts straight to this endpoint,
  // with no flag available to mark it) must return the real, data-grounded
  // recap + reflection question generated for tonight — not whatever Claude's
  // general-purpose tool loop happens to make of a bare "Evening Check In"
  // string with no other signal. Confirmed in production logs: with no
  // short-circuit, that literal string got read as a request to check email.
  // Skip Claude entirely and hand back the pre-generated (or, if the 9 PM
  // scheduler hasn't fired yet, freshly generated) message directly.
  if (isWinddownOpener || message.trim().toLowerCase() === "evening check in") {
    const openerProfile = await getProfile(sessionUserName).catch(() => null);
    let tonightMessage = await getTonightMessage(sessionUserName).catch(() => null);
    if (!tonightMessage) {
      const companionName = getCompanionDisplayName(
        openerProfile?.companionPersona ?? null,
        openerProfile?.companionName ?? null
      );
      tonightMessage = await generateOpeningMessage(companionName, sessionUserName);
      await markFiredToday(sessionUserName).catch((err) =>
        log.warn({ err }, "[chatHandlerCore] Winddown markFiredToday failed"));
      await saveTonightMessage(sessionUserName, tonightMessage).catch((err) =>
        log.warn({ err }, "[chatHandlerCore] Winddown saveTonightMessage failed"));
    }
    await setWinddownActive(sessionUserName, true).catch((err) =>
      log.warn({ err }, "[chatHandlerCore] Winddown setWinddownActive failed"));

    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runPostProcessing(sessionUserName, message, tonightMessage, req.history.slice(-ACTIVE_CONTEXT_LIMIT), openerProfile, deviceId, messageId);
    return { reply: tonightMessage, action: { type: "none" }, messageId };
  }

  // ── Wind-down reply claim ────────────────────────────────────────────────────
  // If tonight's evening check-in is active and this message isn't the one that
  // OPENED it (isWinddownOpener from routes/chat.ts's winddownRequest flag, or
  // "Evening Check In" — the literal text the FCM push tap sends, which has no
  // equivalent flag available without a native app change), this message IS the
  // user's reply to it. Atomically claim the window closed (single UPDATE ...
  // WHERE active = true RETURNING id) so near-simultaneous messages can't each
  // observe it open and each try to capture — only whichever request wins the
  // claim is eligible to persist a capture, and only once we know below whether
  // Claude treated this as a plain reflective reply or an actionable request.
  let winddownReplyClaimed = false;
  let winddownStoicPhase: number | null = null;
  if (!isWinddownOpener && message.trim().toLowerCase() !== "evening check in") {
    winddownReplyClaimed = await claimWinddownReply(sessionUserName).catch((err) => {
      log.warn({ err }, "[chatHandlerCore] Winddown claim failed");
      return false;
    });
    if (winddownReplyClaimed) {
      // Plain fact storage alongside the capture — no classification, just
      // which phase was active when this reflection was written.
      const stoicEntry = await getStoicForUser(sessionUserName).catch(() => null);
      winddownStoicPhase = stoicEntry?.phase ?? null;
    }
  }

  let history = req.history.slice(-ACTIVE_CONTEXT_LIMIT);

  // ── Load always-on context in parallel ─────────────────────────────────────
  const [
    userProfile,
    profileItems,
    keyPeople,
    allLists,
    pendingReminderRows,
    todayEvents,
    dbHistory,
  ] = await Promise.all([
    getProfile(sessionUserName).catch(() => null),
    getProfileItems(undefined, sessionUserName).catch(() => []),
    getPeople(sessionUserName).catch((): KeyPerson[] => []),
    getAllLists(sessionUserName).catch(() => ({} as Record<string, string[]>)),
    query<{ id: number; reminder_text: string; fire_at: string; for_contact: string | null }>(
      `SELECT id, reminder_text, fire_at, for_contact FROM reminders
       WHERE user_name = $1 AND status = 'pending' ORDER BY fire_at ASC`,
      [sessionUserName]
    ).then((r) => r.rows).catch(
      (): Array<{ id: number; reminder_text: string; fire_at: string; for_contact: string | null }> => []
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
  const pendingAtticCleanup = getPendingAtticCleanup(sessionUserName);
  const pendingListCleanup = getPendingListCleanup(sessionUserName);
  const pendingSaveOffers   = getPendingSaveOffers(sessionUserName);
  const pendingListConflict = getPendingListTypeConflict(sessionUserName);
  const pendingProactivePicks = await getProactivePicks(sessionUserName);
  const mostRecentShownObservation = await getMostRecentShownObservation(sessionUserName).catch(() => null);
  // When the shown observation carries a suggested goal fit, resolve the
  // target goal's title now so the dynamicPrompt block below can name it
  // without Claude having to retype or guess it.
  let pendingGoalConnection: { connectionId: number; goalId: number; goalTitle: string } | null = null;
  if (mostRecentShownObservation?.related_connection_id) {
    const conn = await getConnectionById(mostRecentShownObservation.related_connection_id).catch(() => null);
    if (conn && conn.status === "suggested" && conn.target_type === "goal") {
      const goalId = parseInt(conn.target_id, 10);
      const goal = await getGoalById(goalId, sessionUserName).catch(() => null);
      if (goal) pendingGoalConnection = { connectionId: conn.id, goalId, goalTitle: goal.title };
    }
  }

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

  const activeScreenBlock = requestContext
    ? `\n\n[Active Screen: ${requestContext} list]\nWhen adding items without specifying a list, use "${requestContext}".`
    : "";

  let dynamicPrompt =
    getCurrentDateTimeBlock(timezone) +
    profileItemsBlock +
    buildListsBlock(allLists, requestContext) +
    buildRemindersBlock(pendingReminderRows, timezone) +
    buildCalendarBlock(todayEvents, timezone) +
    activeScreenBlock;

  // Inject active email triage context so Claude has gmailIds for actions
  const activeTriageSession = getTriageSession(sessionUserName);
  if (activeTriageSession) {
    const currentEmail = activeTriageSession.emails[activeTriageSession.currentIndex];
    if (currentEmail) {
      dynamicPrompt += `\n\n[Active Email Triage — Email ${activeTriageSession.currentIndex + 1} of ${activeTriageSession.emails.length}]\n` +
        `Current email:\n` +
        `From: ${currentEmail.from}\n` +
        `Subject: ${currentEmail.subject}\n` +
        `gmailId: ${currentEmail.gmailId}\n` +
        `Preview: ${currentEmail.snippet}\n\n` +
        `If the user wants to reply, delete, archive, or mark this email done, use this gmailId in the action tag.`;
    }
  }

  // ── Pre-flight: handle active multi-turn flows ───────────────────────────────

  // SMS flow in progress
  const lastSmsPayload = getLastSmsPayload(sessionUserName);
  // Retry/edit-after-send apply AFTER a text has already been handed off,
  // i.e. exactly when pendingText is null — so this has to be checked
  // independent of pendingText, not nested inside it. Classified via a real
  // Haiku call rather than a keyword regex: words like "actually", "change",
  // or "edit" are common enough in ordinary conversation that matching on
  // them directly would hijack unrelated messages into the SMS-edit flow
  // for the full length of lastSmsPayload's retry window. Only classified
  // when there's actually a recent send to be talking about.
  let isSmsRetryRequest = false;
  let isSmsEditAfterSend = false;
  if (pendingText === null && lastSmsPayload) {
    const followupIntent = await classifySmsFollowupIntent(message).catch((): "none" => "none");
    isSmsRetryRequest = followupIntent === "retry";
    isSmsEditAfterSend = followupIntent === "edit";
  }

  if (pendingText !== null && pendingText.phase === 'awaiting_confirmation') {
    dynamicPrompt += `\n\n[Pending SMS Draft]\nTo: ${pendingText.recipientName}\nDraft: "${pendingText.composedBody}"\n\n` +
      `Handle the user's response naturally:\n` +
      `- If they approve (yes, looks good, send it, perfect, etc.) → emit [ACTION:sms_send]\n` +
      `- If they give direction or want changes → end your reply with [ACTION:sms_revise|feedback=<their exact words>]. The server recomposes the text from that feedback — do not try to write the revised text yourself here.\n` +
      `- If they say 'send that word for word' or 'use exactly what I typed' → end your reply with [ACTION:sms_send|body=<their exact typed text>], using their exact text verbatim, not a paraphrase.\n` +
      `- If they cancel → emit [ACTION:sms_cancel]\n` +
      `Emitting the action tag is not optional — a friendly sentence alone does not actually revise or send anything; only the tag does.`;
  } else if (pendingText !== null || isSmsRetryRequest || isSmsEditAfterSend) {
    const textResult = await handleText({
      message,
      sessionUserName,
      deviceId,
      isTextFlowActive: true,
      pendingText,
      isSmsRetryRequest,
      isSmsEditAfterSend,
      lastSmsPayload,
      userProfile,
      log,
    });
    if (textResult.hardcodedResponse) {
      runPostProcessing(sessionUserName, message, textResult.hardcodedResponse, history, userProfile, deviceId, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      return {
        reply: textResult.hardcodedResponse,
        action: { type: "send_sms" },
        smsPayload: textResult.smsPayload,
        messageId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      runPostProcessing(sessionUserName, message, resResult.hardcodedResponse, history, userProfile, deviceId, messageId);
      return {
        reply:              resResult.hardcodedResponse,
        action:             { type: "make_reservation" },
        reservationPayload: resResult.reservationPayload,
        messageId,
      };
    }
    dynamicPrompt += resResult.contextBlock;
  }

  // Email reply flow in progress — inject draft context so Claude can decide
  // naturally via email_send / email_revise / email_cancel action tags.
  if (pendingEmailReply !== null) {
    dynamicPrompt += `\n\n[Pending Email Draft for ${pendingEmailReply.recipientName}]\n` +
      `To: ${pendingEmailReply.to}\n` +
      `Subject: ${pendingEmailReply.subject}\n` +
      `Current draft:\n"${pendingEmailReply.draftBody}"\n\n` +
      `If this message is actually about that draft, handle it naturally:\n` +
      `- If they approve (yes, looks good, send it, perfect, etc.) → emit [ACTION:email_send]\n` +
      `- If they give direction or want changes → end your reply with [ACTION:email_revise|feedback=<their exact words>]. The server recomposes the draft from that feedback — do not try to write the revised draft yourself here.\n` +
      `- If they say 'send that word for word' or 'use exactly what I typed' → end your reply with [ACTION:email_send|body=<their exact typed text>], using their exact text verbatim, not a paraphrase.\n` +
      `- If they cancel → emit [ACTION:email_cancel]\n` +
      `Emitting the action tag is not optional when they ARE responding to it — a friendly sentence alone ("Sounds good, I'll make that change") does not actually revise or send anything; only the tag does. Never claim a change was made unless you emitted [ACTION:email_revise] in the same reply.\n` +
      `If this message is clearly about something else instead (a different email, an unrelated request) — most likely because they moved on without resolving this draft — just handle that normally and don't mention the draft at all; it's still here waiting whenever they do come back to it.`;
  }

  // Attic cleanup flow in progress — inject the proposed candidate list so
  // Claude can interpret confirm/exclude/cancel naturally.
  if (pendingAtticCleanup !== null) {
    const list = pendingAtticCleanup.candidates
      .map((c, i) => `${i + 1}. [${c.sourceType}, saved ${new Date(c.createdAt).toLocaleDateString()}] ${c.rawContent.slice(0, 140)}`)
      .join("\n");
    dynamicPrompt += `\n\n[Pending Attic Cleanup — ${pendingAtticCleanup.candidates.length} items older than ${pendingAtticCleanup.thresholdDays} days]\n${list}\n\n` +
      `If __USER__ approves archiving all of them, emit [ACTION:archive_attic_confirm]. If they want to keep specific numbered items, emit [ACTION:archive_attic_confirm|exclude=<comma-separated numbers>]. If they decline, emit [ACTION:archive_attic_cancel].`;
  }

  // List cleanup flow in progress — same pattern as Attic cleanup above.
  if (pendingListCleanup !== null) {
    const list = pendingListCleanup.candidates
      .map((c, i) => `${i + 1}. [${c.listName}, saved ${new Date(c.createdAt).toLocaleDateString()}] ${c.itemText}`)
      .join("\n");
    const scopeDesc = pendingListCleanup.listName ? `your "${pendingListCleanup.listName}" list` : "your lists";
    dynamicPrompt += `\n\n[Pending List Cleanup — ${pendingListCleanup.candidates.length} items in ${scopeDesc} older than ${pendingListCleanup.thresholdDays} days]\n${list}\n\n` +
      `If __USER__ approves archiving all of them, emit [ACTION:archive_list_confirm]. If they want to keep specific numbered items, emit [ACTION:archive_list_confirm|exclude=<comma-separated numbers>]. If they decline, emit [ACTION:archive_list_cancel].`;
  }

  // Proactive-picks notification tapped — the push never named the picks
  // (a generic teaser only), so this is the real curated list Winston
  // actually generated. Only inject while genuinely current: the next
  // Monday/Thursday run replaces this cache, but a stale leftover from a
  // much earlier run (e.g. notifications went untapped for a week) isn't
  // worth grounding a reply in.
  const PROACTIVE_PICKS_STALE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  if (pendingProactivePicks !== null && Date.now() - pendingProactivePicks.generatedAt < PROACTIVE_PICKS_STALE_MS) {
    const list = pendingProactivePicks.picks
      .map((p, i) => {
        const when = p.dateLabel || p.dateISO || "ongoing";
        const where = p.venue ? ` at ${p.venue}` : "";
        const link = p.url ? `\n   Link: ${p.url}` : "";
        return `${i + 1}. [${p.category}] "${p.name}"${where} — ${when}. ${p.reason}${link}`;
      })
      .join("\n");
    dynamicPrompt += `\n\n[Your Recent Picks — proactive suggestions already generated for __USER__ in ${pendingProactivePicks.city}]\n${list}\n\n` +
      `This is what you actually found and picked — the notification that brought them here deliberately didn't name them, so this is the reveal. If __USER__'s message is a short, generic question like "what did you find," "what did you find for me," or similar — that means THIS, always, regardless of what was discussed earlier in the conversation. Answer with these picks specifically; do not continue a prior unrelated topic just because it happens to be the most recent thing in the conversation history above — this notification tap is a fresh request, not a continuation. Present the list naturally in your own words (don't just repeat this block verbatim). Every pick above that has a Link MUST have that exact URL included in this very reply, formatted as a markdown link (e.g. "[get tickets](https://...)" or "[more info](https://...)") — this is not optional and not conditional on whether they ask for it; they expect to be able to tap straight through to it from the reveal itself. Only skip the link for a pick that has none. If they later ask for more detail or "why this one," answer from this real information — don't guess or re-search.`;
  }

  // Save-offer flow in progress — inject what was actually offered so a
  // later "save that" resolves by number, not by retyping content.
  if (pendingSaveOffers !== null && pendingSaveOffers.candidates.length > 0) {
    const list = pendingSaveOffers.candidates
      .map((c, i) => `${i + 1}. ${c.title}${c.url ? ` (${c.url})` : ""}`)
      .join("\n");
    dynamicPrompt += `\n\n[Pending Save Offer(s) — from your last recommendation]\n${list}\n\n` +
      `If __USER__ confirms saving one of these, you MUST end your reply with [ACTION:add_list_item|list=<list>|offerIndex=<N>], using the number from the list above — do not retype its title, content, or url yourself. ` +
      `This is not optional: telling __USER__ it's saved without emitting this exact tag means nothing is actually written to their list — the words alone don't save anything. Do not skip the tag just because a friendly confirmation sentence feels sufficient by itself.`;
  }

  // List-type conflict — a structured save (title+content) was about to
  // land in a list that's currently a notepad (single freeform blob), where
  // it would silently never show up. Held instead of written; ask which way
  // to go.
  if (pendingListConflict !== null) {
    dynamicPrompt += `\n\n[List Type Conflict — "${pendingListConflict.listName}" is currently a notepad, not a checklist]\n` +
      `You just told __USER__ their "${pendingListConflict.listName}" list is set up as a single freeform note, not a checklist of separate items, and asked what to do with "${pendingListConflict.title}".\n` +
      `If __USER__ wants to convert "${pendingListConflict.listName}" to a checklist (yes, convert it, make it a checklist, etc.) — any existing content in it is kept, just as the first item — emit [ACTION:convert_notepad_confirm]. Do not retype the title, content, or url; the server resolves those from what you already captured.\n` +
      `If __USER__ names a different list to use instead, emit [ACTION:add_list_item|list=<that list name>|fromConflict=true] — do not retype the title, content, or url yourself.\n` +
      `If __USER__ wants to drop it entirely, emit [ACTION:convert_notepad_cancel].`;
  }

  // Goal-creation offer — only injected when the most recently shown
  // observation is a cluster that's genuinely recurring (goal_eligible, set
  // by clusterPass when the same attic items surfaced across a separate,
  // later batch_daily run — a single one-off cluster never sets this).
  // Once accepted/dismissed its status changes, so this naturally stops
  // being injected without any extra bookkeeping here.
  if (mostRecentShownObservation?.observation_type === "cluster" && mostRecentShownObservation.goal_eligible) {
    dynamicPrompt += `\n\n[Recurring Pattern — goal-creation offer]\n` +
      `You recently told __USER__: "${mostRecentShownObservation.message}"\n` +
      `If __USER__ wants to make this a real goal (yes, do it, make that a goal, etc.), emit [ACTION:create_goal_from_observation] — no parameters, the server resolves the goal's title and description from what was already captured, do not retype them yourself.\n` +
      `If __USER__ doesn't want this, that's a normal observation dismissal — emit [ACTION:correct_observation|type=dismiss] like any other.`;
  }

  // Goal-connection offer — only injected when the most recently shown
  // observation carries a suggested (not yet resolved) connections row,
  // written by dotConnectorPass/patternObservationPass when a saved item
  // genuinely fit an existing goal. Four resolutions map to four different
  // outcomes; confirm/dismiss reuse the existing correct_observation
  // machinery (now generalized to cascade to the linked connection).
  if (pendingGoalConnection) {
    dynamicPrompt += `\n\n[Goal Connection — suggested fit to an existing goal]\n` +
      `You recently told __USER__: "${mostRecentShownObservation!.message}" — noting a fit to their goal "${pendingGoalConnection.goalTitle}".\n` +
      `If __USER__ confirms the connection (yes, that's right, good catch, etc.), emit [ACTION:correct_observation|type=elevate].\n` +
      `If __USER__ says it doesn't relate to that goal at all, emit [ACTION:correct_observation|type=dismiss].\n` +
      `If __USER__ says it actually relates to a DIFFERENT goal, emit [ACTION:reconnect_goal_observation|goal=<the other goal's name as they said it>].\n` +
      `If __USER__ says this should be its own new goal instead (not connected to "${pendingGoalConnection.goalTitle}"), emit [ACTION:make_goal_aspirational_from_observation] — no parameters, the server derives the new goal from what was already captured.`;
  }

  // Meeting request flow in progress — separate from reply drafts (E007-MEET), unchanged.
  if (pendingMeetingReqs.length > 0) {
    const isEmailReplyAccepted = await classifyConfirmationIntent(message).then(r => r === 'send').catch(() => false);
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
      isEmailReplyAccepted,
      pendingMeetingRequests: pendingMeetingReqs,
      pendingEmailReply: null,
      userProfile,
      log,
    });
    if (emailResult.hardcodedResponse) {
      if (emailResult.emailPayload) {
        broadcastToUser(sessionUserName, "email-compose", { type: "email_compose", ...emailResult.emailPayload });
      }
      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      runPostProcessing(sessionUserName, message, emailResult.hardcodedResponse, history, userProfile, deviceId, messageId);
      if (winddownReplyClaimed) {
        saveLifeCapture(sessionUserName, message, "evening", winddownStoicPhase).then((capture) => {
          if (capture) {
            runConnectionEngine(sessionUserName, "capture").catch((err) => log.warn({ err }, "[chatHandlerCore] runConnectionEngine failed"));
          }
        }).catch((err) => log.warn({ err }, "[chatHandlerCore] Winddown reflection capture failed"));
      }
      return {
        reply: emailResult.hardcodedResponse,
        action: { type: "none" },
        messageId,
        emailPayload: emailResult.emailPayload,
      };
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
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runPostProcessing(sessionUserName, message, fallback, history, userProfile, deviceId, messageId);
    if (winddownReplyClaimed) {
      saveLifeCapture(sessionUserName, message, "evening", winddownStoicPhase).then((capture) => {
        if (capture) {
          runConnectionEngine(sessionUserName, "capture").catch((err) => log.warn({ err }, "[chatHandlerCore] runConnectionEngine failed"));
        }
      }).catch((err) => log.warn({ err }, "[chatHandlerCore] Winddown reflection capture failed"));
    }
    return { reply: fallback, action: { type: "none" }, messageId };
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
      case "add_list_item": {
        const offerIndexRaw = parts.offerIndex ? parseInt(parts.offerIndex, 10) : NaN;
        action = {
          type: "add_todo",
          listName: parts.list ?? "",
          itemText: parts.items ?? "",
          notes: parts.notes ?? null,
          url: parts.url ?? null,
          offerIndex: Number.isNaN(offerIndexRaw) ? null : offerIndexRaw,
          fromConflict: parts.fromConflict === "true",
        };
        break;
      }
      case "offer_save":
        action = { type: "offer_save", offers: parts.offers ?? null };
        break;
      case "convert_notepad_confirm":
        action = { type: "convert_notepad_confirm" };
        break;
      case "convert_notepad_cancel":
        action = { type: "convert_notepad_cancel" };
        break;
      case "create_goal_from_observation":
        action = { type: "create_goal_from_observation" };
        break;
      case "reconnect_goal_observation":
        action = { type: "reconnect_goal_observation", goalName: parts.goal ?? null };
        break;
      case "make_goal_aspirational_from_observation":
        action = { type: "make_goal_aspirational_from_observation" };
        break;
      case "add_todo":
        action = { type: "add_todo", listName: "reminders", itemText: parts.task ?? "" };
        break;
      case "add_reminder":
        action = { type: "add_reminder", itemText: parts.task ?? "", reminderTime: parts.time ?? null };
        break;
      case "complete_reminder": {
        const idRaw = parts.id ? parseInt(parts.id, 10) : NaN;
        action = { type: "complete_reminder", reminderId: Number.isNaN(idRaw) ? null : idRaw };
        break;
      }
      case "add_todo_with_reminder":
        action = { type: "add_todo_with_reminder", itemText: parts.task ?? "", reminderTime: parts.time ?? null };
        break;
      case "send_sms":
        action = { type: "send_sms", recipientName: parts.recipient ?? "", smsBody: parts.body ?? null };
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
      case "email_next":
        action = { type: "email_next" };
        break;
      case "email_reply":
        action = { type: "email_reply", gmailId: parts.gmailId ?? null };
        break;
      case "email_send":
        action = { type: "email_send", body: parts.body ?? null };
        break;
      case "email_revise":
        action = { type: "email_revise", feedback: parts.feedback ?? null };
        break;
      case "email_cancel":
        action = { type: "email_cancel" };
        break;
      case "email_compose":
        action = { type: "email_compose", recipientName: parts.to ?? null };
        break;
      case "sms_send":
        action = { type: "sms_send", body: parts.body ?? null };
        break;
      case "sms_revise":
        action = { type: "sms_revise", feedback: parts.feedback ?? null };
        break;
      case "sms_cancel":
        action = { type: "sms_cancel" };
        break;
      case "make_reservation":
        action = { type: "make_reservation", restaurantName: parts.restaurant ?? "" };
        break;
      case "morning_rundown":
        action = { type: "morning_rundown" };
        break;
      case "local_activity_search":
        action = {
          type: "local_activity_search",
          localActivityContext: parts.context === "weekend" ? "weekend" : "week",
        };
        break;
      case "save_to_attic":
        action = { type: "save_to_attic", itemText: parts.content ?? "" };
        break;
      case "correct_observation":
        action = {
          type: "correct_observation",
          correctionType: (parts.type ?? "dismiss") as "dismiss" | "reject" | "elevate" | "forget",
          feedback: parts.feedback ?? "",
        };
        break;
      case "cleanup_attic":
        action = { type: "cleanup_attic" };
        break;
      case "archive_attic_confirm":
        action = { type: "archive_attic_confirm", excludeIndexes: parts.exclude ?? null };
        break;
      case "archive_attic_cancel":
        action = { type: "archive_attic_cancel" };
        break;
      case "cleanup_list":
        action = { type: "cleanup_list", listNameForCleanup: parts.list ?? null };
        break;
      case "archive_list_confirm":
        action = { type: "archive_list_confirm", excludeIndexes: parts.exclude ?? null };
        break;
      case "archive_list_cancel":
        action = { type: "archive_list_cancel" };
        break;
    }
  }
  // Safety net: even with explicit instruction, Claude sometimes narrates a
  // confident "saved!" while emitting no action tag at all (or [ACTION:none])
  // — observed live, intermittently, despite a correctly-injected pending
  // offer and correctly-worded guidance. When that happens with exactly one
  // unambiguous pending candidate, the reply text itself still reliably names
  // which list it claims to have saved to ("...to your **wish list**!") — so
  // recover the real intent from that instead of losing the save outright.
  if (action.type === "none" && pendingSaveOffers && pendingSaveOffers.candidates.length === 1) {
    const confirmsSave = /\b(saved|added|done)\b.{0,60}\bto\b.{0,40}\blist\b/i.test(finalReply);
    const listNameMatch = finalReply.match(/to (?:your |the )?\*{0,2}([a-z0-9 '&-]+?)\*{0,2} list/i);
    if (confirmsSave && listNameMatch) {
      action = {
        type: "add_todo",
        listName: listNameMatch[1].trim(),
        itemText: "",
        notes: null,
        url: null,
        offerIndex: 1,
      };
      log.warn(
        { reply: finalReply.slice(0, 200) },
        "[chatHandlerCore] Recovered save-offer confirmation with no action tag — model narrated success without emitting the tag"
      );
    }
  }

  // Same safety net for the list-type-conflict flow's "yes, convert it" path
  // — the rename-to-a-different-list path already relies on Claude naming a
  // list correctly, same as any other add_list_item call, so it isn't
  // covered here.
  if (action.type === "none" && pendingListConflict !== null) {
    const confirmsConvert = /\bconvert\b|\bmake it a checklist\b|\bturn it into a checklist\b/i.test(finalReply)
      && /\b(yes|done|got it|sure|sounds good|will do|converting|converted)\b/i.test(finalReply);
    if (confirmsConvert) {
      action = { type: "convert_notepad_confirm" };
      log.warn(
        { reply: finalReply.slice(0, 200) },
        "[chatHandlerCore] Recovered notepad-conversion confirmation with no action tag — model narrated success without emitting the tag"
      );
    }
  }

  // Safety net: the primary Claude call has web_search available directly
  // (for ordinary "what's the weather"/"how are the markets" questions), and
  // observed live, it sometimes uses that to answer an explicit morning-
  // briefing request itself — producing a plausible-looking but entirely
  // unverified "Morning Run Down" (invented weather, invented activities, no
  // real search grounding beyond whatever it does on its own) instead of
  // emitting the tag that routes to the real generateDailyBrief() pipeline.
  // Confirmed via chat history: 4 of 5 consecutive "give me my morning
  // briefing" requests in one real session got a fabricated reply like this;
  // only the request whose reply actually matched a real generateDailyBrief()
  // log entry was genuine. This is user-message-driven (the trigger phrase
  // itself), not a narration to recover from Claude's reply — force the real
  // action whenever the request is unambiguous, regardless of what Claude did.
  if (action.type !== "morning_rundown" && /\bmorning (run.?down|briefing)\b|\bdaily briefing\b/i.test(message)) {
    action = { type: "morning_rundown" };
    log.warn(
      { message, claudeAction: tagMatch?.[1] ?? "none", reply: finalReply.slice(0, 200) },
      "[chatHandlerCore] Forced morning_rundown — explicit request but Claude answered directly instead of emitting the tag"
    );
  }

  log.info({ actionType: action.type, tag: tagMatch?.[1] ?? "none" }, "[chatHandlerCore] Action parsed");

  // ── Execute action ───────────────────────────────────────────────────────────
  let smsPayload:         SmsPayload | undefined          = undefined;
  let reservationPayload: ReservationPayload | undefined  = undefined;
  let navigationUrl:      string | undefined              = undefined;
  let emailPayload:       NewChatResponse["emailPayload"] = undefined;

  switch (action.type) {

    case "none":
      break;

    // ── add_todo ──────────────────────────────────────────────────────────────
    case "add_todo": {
      const listName = requestContext?.trim() || action.listName?.trim() || "";

      // Resolve from a pending save offer first when referenced — the real
      // title/detail/url captured the moment Winston offered it, not
      // retyped from memory on this later turn. Falls through to items=/
      // notes=/url= (with the history-lookback fallback for notes) when
      // there's no valid offer to resolve from.
      const offerCandidate = action.offerIndex && pendingSaveOffers
        ? pendingSaveOffers.candidates[action.offerIndex - 1]
        : undefined;

      let items: string[];
      let resolvedNotes: string | null;
      let resolvedUrl: string | null;

      if (action.fromConflict && pendingListConflict) {
        // Resolving a held list-type-conflict save with a different target
        // list — the real title/notes/url were captured when the conflict
        // was first detected, not retyped by Claude just now.
        items = [pendingListConflict.title];
        resolvedNotes = pendingListConflict.notes;
        resolvedUrl = pendingListConflict.url;
        setPendingListTypeConflict(sessionUserName, null);
      } else if (offerCandidate) {
        items = [offerCandidate.title];
        // The shared turn-level detail only describes ONE thing when only one
        // candidate was offered (a recipe, a single product) — that's the
        // title/detail-split case, so it belongs in notes. When several
        // candidates were offered and the user picked just one, that same
        // text covers all of them (comparisons, "MACC's Take", etc.), so it
        // would pollute this item's notes rather than describe it — treat
        // it like any other simple single-value save instead.
        resolvedNotes = pendingSaveOffers?.candidates.length === 1 ? (pendingSaveOffers.detail || null) : null;
        resolvedUrl = offerCandidate.url;
        setPendingSaveOffers(sessionUserName, null);
      } else {
        items = (action.itemText ?? "").split(";").map((s) => s.trim()).filter(Boolean);
        // Prefer the exact text from the conversation over Claude's
        // retyped notes= value. When notes= signals a title+content save,
        // the full content (a recipe, etc.) was already generated and
        // shown one turn ago — asking the model to reproduce it verbatim
        // from memory into a tag parameter is unreliable no matter how
        // the instruction is worded; it compresses. The real thing is
        // already sitting in history exactly as the user saw it.
        resolvedNotes = action.notes ?? null;
        if (items.length === 1 && resolvedNotes) {
          const lastAssistantTurn = [...history].reverse().find((m) => m.role === "assistant");
          const historyContent = lastAssistantTurn?.content?.trim();
          if (historyContent && historyContent.length > resolvedNotes.length) {
            resolvedNotes = historyContent;
          }
        }
        resolvedUrl = action.url ?? null;
      }

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
        // A structured save (a real title + full content) into a notepad-type
        // list would silently vanish from the user's point of view — the
        // notepad UI only ever shows/edits a single freeform blob, so the
        // saved row would sit in the database with nothing on screen
        // reflecting it. Hold it and ask instead of writing it there.
        // Skipped when this save is itself resolving a conflict — by then
        // either the list was just converted (convert_notepad_confirm) or
        // the user named a fresh target, so re-checking would just loop.
        if (items.length === 1 && resolvedNotes && !action.fromConflict) {
          const currentType = await getListType(sessionUserName, listName).catch(() => "checklist");
          if (currentType === "notepad") {
            setPendingListTypeConflict(sessionUserName, { listName, title: items[0], notes: resolvedNotes, url: resolvedUrl });
            finalReply =
              `Heads up — your "${listName}" list is currently a single freeform note, not a checklist, so "${items[0]}" wouldn't really show up right if I saved it there as-is. ` +
              `Want me to convert "${listName}" to a checklist (anything already in it stays, just as the first item), or should I use a different list name for this instead?`;
            log.info({ listName, title: items[0] }, "[chatHandlerCore] Notepad list-type conflict — save held");
            break;
          }
        }
        if (items.length > 0) {
          try {
            const inserted = await addItems(listName, items, sessionUserName, undefined, resolvedNotes, resolvedUrl);
            if (inserted.length > 0) batchCategorizeAndUpdateItems(inserted).catch(() => {});
            await syncListItemToConnections(listName, items, sessionUserName).catch(() => {});
            log.info({ listName, items, hasNotes: !!resolvedNotes, hasUrl: !!resolvedUrl, fromOffer: !!offerCandidate }, "[chatHandlerCore] List items added");
          } catch (err) {
            log.warn({ err }, "[chatHandlerCore] addItems failed");
          }
        }
      }
      break;
    }

    // ── offer_save ────────────────────────────────────────────────────────────
    // Captures a save-worthy recommendation's real title(s) and source
    // URL(s) at the moment it's made — same turn as the search that backs
    // it — rather than asking Claude to retype them later, which is where
    // both the notes and the URL used to get lost.
    case "offer_save": {
      const offersRaw = (action.offers ?? "").split(";").map((s) => s.trim()).filter(Boolean);
      if (offersRaw.length > 0) {
        // Real URLs this turn's search actually returned — the only ones a
        // claimed url is allowed to match. Blocks a hallucinated URL from
        // ever reaching storage.
        const realUrls  = new Set<string>();
        const realHosts = new Set<string>();
        const hostOf = (u: string): string | null => {
          try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); }
          catch { return null; }
        };
        for (const block of primaryResponse.content) {
          if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const result of block.content) {
              if (result.type === "web_search_result" && result.url) {
                realUrls.add(result.url);
                const h = hostOf(result.url);
                if (h) realHosts.add(h);
              }
            }
          }
        }
        const candidates: SaveOfferCandidate[] = offersRaw
          .map((entry) => {
            const eq = entry.indexOf("=");
            const title = (eq === -1 ? entry : entry.slice(0, eq)).trim();
            const claimedUrl = eq === -1 ? null : entry.slice(eq + 1).trim();
            // Exact match is the strongest signal, but Claude often retypes a
            // real result's URL with small normalization differences (a
            // trailing slash, a dropped query string, www vs not) — reject
            // only when even the DOMAIN doesn't appear anywhere in this
            // turn's real search results, since that's what actually
            // indicates a hallucinated link rather than a reformatted one.
            const claimedHost = claimedUrl ? hostOf(claimedUrl) : null;
            const url = claimedUrl && (realUrls.has(claimedUrl) || (claimedHost && realHosts.has(claimedHost)))
              ? claimedUrl
              : null;
            return { title, url };
          })
          .filter((c) => c.title.length > 0);

        if (candidates.length > 0) {
          setPendingSaveOffers(sessionUserName, { candidates, detail: finalReply });
          log.info(
            { count: candidates.length, withUrl: candidates.filter((c) => c.url).length },
            "[chatHandlerCore] Save offer(s) cached"
          );
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

    // ── complete_reminder ─────────────────────────────────────────────────────
    // Handles both "mark done" and "drop/forget it" — the reminders table has
    // no separate dismissed state (only pending/completed, same as the
    // scheduler's own fire-time transition in scheduler.ts), so both intents
    // resolve to the same status update.
    case "complete_reminder": {
      if (action.reminderId) {
        try {
          const done = await markReminderDone(action.reminderId);
          log.info({ reminderId: action.reminderId, done }, "[chatHandlerCore] Reminder marked done");
        } catch (err) {
          log.warn({ err, reminderId: action.reminderId }, "[chatHandlerCore] markReminderDone failed");
        }
      } else {
        log.info({}, "[chatHandlerCore] complete_reminder had no valid id to target");
      }
      break;
    }

    // ── save_to_attic ─────────────────────────────────────────────────────────
    case "save_to_attic": {
      const content = action.itemText?.trim() ?? "";
      if (content) {
        try {
          await saveAtticItem({ userName: sessionUserName, sourceType: "voice", rawContent: content });
          log.info({ chars: content.length }, "[chatHandlerCore] Attic item saved");
          runConnectionEngine(sessionUserName, "capture").catch((err) => log.warn({ err }, "[chatHandlerCore] runConnectionEngine failed"));
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] saveAtticItem failed");
        }
      }
      break;
    }

    // ── correct_observation ───────────────────────────────────────────────────
    case "correct_observation": {
      const correctionType = action.correctionType ?? "dismiss";
      const feedback = action.feedback?.trim() ?? "";
      try {
        const result = await applyObservationCorrection(sessionUserName, correctionType, feedback);
        if (result) {
          log.info({ correctionType, observationId: result.observationId }, "[chatHandlerCore] Observation correction applied");
        } else {
          log.info({ correctionType }, "[chatHandlerCore] Observation correction had nothing to target");
        }
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] applyObservationCorrection failed");
      }
      break;
    }

    // ── create_goal_from_observation ─────────────────────────────────────────
    // Resolves entirely from mostRecentShownObservation (already fetched
    // this turn, same "no ID travels through the tag" pattern as
    // correct_observation) — Claude never retypes the title/description.
    case "create_goal_from_observation": {
      const target = mostRecentShownObservation;
      if (!target || target.observation_type !== "cluster" || !target.goal_eligible) {
        log.info({ target: target?.id ?? null }, "[chatHandlerCore] create_goal_from_observation had nothing eligible to target");
        break;
      }
      try {
        const title = (target.theme?.trim() || target.message.replace(GOAL_OFFER_SUFFIX, "").trim()).slice(0, 120);
        const description = target.message.endsWith(GOAL_OFFER_SUFFIX)
          ? target.message.slice(0, -GOAL_OFFER_SUFFIX.length).trim()
          : target.message.trim();
        // A cluster is an emerging interest Winston noticed, not a commitment
        // the user made — starts aspirational, not active.
        const goal = await createGoal(sessionUserName, title, description, "aspirational");
        await linkGoalToObservation(goal.id, target.id);
        await markObservationAccepted(target.id);
        finalReply = `Done — I've added "${title}" to your goals.`;
        log.info({ goalId: goal.id, observationId: target.id, title }, "[chatHandlerCore] Goal created from cluster observation");
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] create_goal_from_observation failed");
      }
      break;
    }

    // ── reconnect_goal_observation ──────────────────────────────────────────
    // "Connect to a different goal instead" — the one resolution that needs a
    // real param, since the server can't infer WHICH other goal from context
    // alone. Same source item, new target: dismiss the old suggested
    // connection, write a fresh one directly as accepted (the user just
    // confirmed it), repoint the observation at it.
    case "reconnect_goal_observation": {
      const target = mostRecentShownObservation;
      const goalName = action.goalName?.trim();
      if (!target || !target.related_connection_id || !goalName) {
        log.info(
          { target: target?.id ?? null, goalName: goalName ?? null },
          "[chatHandlerCore] reconnect_goal_observation had nothing eligible to target"
        );
        break;
      }
      try {
        const oldConnection = await getConnectionById(target.related_connection_id);
        const goals = await getGoals(sessionUserName);
        const needle = goalName.toLowerCase();
        const matchedGoal =
          goals.find((g) => g.title.toLowerCase() === needle) ??
          goals.find((g) => g.title.toLowerCase().includes(needle));
        if (!oldConnection || !matchedGoal) {
          finalReply = `I couldn't find a goal called "${goalName}" — what's it titled exactly?`;
          log.info({ goalName, found: !!matchedGoal }, "[chatHandlerCore] reconnect_goal_observation: goal not found");
          break;
        }
        await updateConnectionStatus(oldConnection.id, "dismissed");
        const newConnectionId = await writeGoalConnection(
          sessionUserName, oldConnection.source_type as SourceType, oldConnection.source_id,
          matchedGoal.id, oldConnection.connection_reason
        );
        await updateConnectionStatus(newConnectionId, "accepted");
        await linkObservationToConnection(target.id, newConnectionId);
        await markObservationAccepted(target.id);
        finalReply = `Got it — connected to "${matchedGoal.title}" instead.`;
        log.info(
          { observationId: target.id, oldConnectionId: oldConnection.id, newConnectionId, goalId: matchedGoal.id },
          "[chatHandlerCore] Goal connection repointed"
        );
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] reconnect_goal_observation failed");
      }
      break;
    }

    // ── make_goal_aspirational_from_observation ─────────────────────────────
    // "Make this its own aspirational goal instead" — declines the suggested
    // connection to the existing goal and creates a new standalone one from
    // the observation's own message, same derivation style as
    // create_goal_from_observation (which has theme/suffix handling this
    // path doesn't need — dot_connector/pattern messages carry neither).
    case "make_goal_aspirational_from_observation": {
      const target = mostRecentShownObservation;
      if (!target || !target.related_connection_id) {
        log.info({ target: target?.id ?? null }, "[chatHandlerCore] make_goal_aspirational_from_observation had nothing eligible to target");
        break;
      }
      try {
        const title = target.message.slice(0, 120);
        const goal = await createGoal(sessionUserName, title, target.message, "aspirational");
        await linkGoalToObservation(goal.id, target.id);
        await updateConnectionStatus(target.related_connection_id, "dismissed");
        await markObservationAccepted(target.id);
        finalReply = `Done — I've added "${title}" as its own goal.`;
        log.info({ goalId: goal.id, observationId: target.id, title }, "[chatHandlerCore] Standalone goal created from goal-connection observation");
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] make_goal_aspirational_from_observation failed");
      }
      break;
    }

    // ── cleanup_attic ─────────────────────────────────────────────────────────
    // Fresh data the initial Claude call couldn't have known yet (same reason
    // composeEmailReply overrides finalReply below) — build the reply here.
    case "cleanup_attic": {
      try {
        const candidates = await getArchiveCandidates(sessionUserName, DEFAULT_ARCHIVE_THRESHOLD_DAYS);
        if (candidates.length === 0) {
          finalReply = "Nothing looks stale in your Attic — everything's fairly recent.";
        } else {
          setPendingAtticCleanup(sessionUserName, { candidates, thresholdDays: DEFAULT_ARCHIVE_THRESHOLD_DAYS });
          const list = candidates
            .map((c, i) => `${i + 1}. [${c.sourceType}, saved ${new Date(c.createdAt).toLocaleDateString()}] ${c.rawContent.slice(0, 140)}`)
            .join("\n");
          finalReply = `Here's what's been sitting in your Attic for over ${DEFAULT_ARCHIVE_THRESHOLD_DAYS} days:\n\n${list}\n\nWant me to archive all of these? Just say the word, or tell me to keep any of them.`;
        }
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] getArchiveCandidates failed");
        finalReply = "I had trouble pulling up your Attic just now — give it another try in a moment.";
      }
      break;
    }

    // ── archive_attic_confirm ────────────────────────────────────────────────
    case "archive_attic_confirm": {
      const pending = pendingAtticCleanup;
      if (pending) {
        const excluded = new Set(
          (action.excludeIndexes ?? "")
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n))
        );
        const idsToArchive = pending.candidates
          .filter((_, i) => !excluded.has(i + 1))
          .map((c) => c.id);
        try {
          const count = await archiveAtticItems(sessionUserName, idsToArchive);
          log.info({ count, excluded: excluded.size }, "[chatHandlerCore] Attic cleanup confirmed");
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] archiveAtticItems failed");
        }
        setPendingAtticCleanup(sessionUserName, null);
      } else {
        log.info({}, "[chatHandlerCore] archive_attic_confirm had nothing pending to target");
      }
      break;
    }

    // ── archive_attic_cancel ─────────────────────────────────────────────────
    case "archive_attic_cancel": {
      setPendingAtticCleanup(sessionUserName, null);
      break;
    }

    // ── cleanup_list ──────────────────────────────────────────────────────────
    // Fresh data the initial Claude call couldn't have known yet, same reason
    // as cleanup_attic above.
    case "cleanup_list": {
      try {
        const listName = action.listNameForCleanup?.trim() || null;
        const candidates = await getListArchiveCandidates(sessionUserName, listName, DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS);
        if (candidates.length === 0) {
          finalReply = listName
            ? `Nothing looks stale in your "${listName}" list — everything's fairly recent.`
            : "Nothing looks stale across your lists — everything's fairly recent.";
        } else {
          setPendingListCleanup(sessionUserName, { listName, candidates, thresholdDays: DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS });
          const list = candidates
            .map((c, i) => `${i + 1}. [${c.listName}, saved ${new Date(c.createdAt).toLocaleDateString()}] ${c.itemText}`)
            .join("\n");
          const scopeDesc = listName ? `your "${listName}" list` : "your lists";
          finalReply = `Here's what's been sitting in ${scopeDesc} for over ${DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS} days:\n\n${list}\n\nWant me to archive all of these? Just say the word, or tell me to keep any of them.`;
        }
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] getListArchiveCandidates failed");
        finalReply = "I had trouble checking your lists just now — give it another try in a moment.";
      }
      break;
    }

    // ── archive_list_confirm ─────────────────────────────────────────────────
    case "archive_list_confirm": {
      const pending = pendingListCleanup;
      if (pending) {
        const excluded = new Set(
          (action.excludeIndexes ?? "")
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n))
        );
        const idsToArchive = pending.candidates
          .filter((_, i) => !excluded.has(i + 1))
          .map((c) => c.id);
        try {
          const count = await archiveListItems(sessionUserName, idsToArchive);
          log.info({ count, excluded: excluded.size }, "[chatHandlerCore] List cleanup confirmed");
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] archiveListItems failed");
        }
        setPendingListCleanup(sessionUserName, null);
      } else {
        log.info({}, "[chatHandlerCore] archive_list_confirm had nothing pending to target");
      }
      break;
    }

    // ── archive_list_cancel ───────────────────────────────────────────────────
    case "archive_list_cancel": {
      setPendingListCleanup(sessionUserName, null);
      break;
    }

    // ── convert_notepad_confirm ──────────────────────────────────────────────
    // Flips the held-conflict list to checklist type, then writes the save
    // that was held for it. No data migration — whatever was already in the
    // list (a notepad's single freeform row, if any) is untouched and just
    // starts rendering as an ordinary checklist item.
    case "convert_notepad_confirm": {
      if (pendingListConflict) {
        try {
          await convertListToChecklist(sessionUserName, pendingListConflict.listName);
          const inserted = await addItems(
            pendingListConflict.listName,
            [pendingListConflict.title],
            sessionUserName,
            undefined,
            pendingListConflict.notes,
            pendingListConflict.url
          );
          if (inserted.length > 0) batchCategorizeAndUpdateItems(inserted).catch(() => {});
          log.info({ listName: pendingListConflict.listName, title: pendingListConflict.title }, "[chatHandlerCore] Notepad list converted and save completed");
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] convert_notepad_confirm failed");
        } finally {
          setPendingListTypeConflict(sessionUserName, null);
        }
      }
      break;
    }

    // ── convert_notepad_cancel ───────────────────────────────────────────────
    case "convert_notepad_cancel": {
      setPendingListTypeConflict(sessionUserName, null);
      break;
    }

    // ── add_todo_with_reminder ────────────────────────────────────────────────
    case "add_todo_with_reminder": {
      const listName = normalizeListName(action.listName?.trim() || "to do");
      const itemText = action.itemText?.trim() ?? "";
      const items    = itemText.split(";").map((s) => s.trim()).filter(Boolean);
      // Plain to-dos live in the reminders table (written below) — same gate
      // add_todo uses. Without this, a to-do with a reminder time attached
      // silently double-wrote into list_items, where nothing ever reads it back.
      const isPlainTodo = listName === "to do" || listName === "reminders";
      if (!isPlainTodo && items.length > 0) {
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

        // Claude explicitly composing and passing body= depends on it
        // reliably noticing the message already had content — confirmed
        // live that a fully-specified, unambiguous request ("Send Susan a
        // text. [full content]. Make it witty") still got asked back
        // instead of used. Don't depend on that alone: if the raw message
        // itself has real content beyond just naming the recipient,
        // compose from it directly, same as the (already-working)
        // awaiting_intent continuation path does on a retry.
        const inlineIntent = action.smsBody ?? extractInlineIntent(message);

        if (inlineIntent) {
          const effectiveTone = detectToneOverride(message) ?? tone;
          try {
            const composedBody = action.smsBody
              ? action.smsBody
              : (await composeTextMessage({
                  recipientName: name,
                  tone: effectiveTone,
                  userIntent: inlineIntent,
                  senderName: userProfile?.name ?? sessionUserName,
                })).body;

            setPendingText(sessionUserName, {
              phase:          "awaiting_confirmation",
              recipientName:  name,
              recipientPhone: phone,
              tone:           effectiveTone,
              composedBody,
            });
            finalReply =
              `Here's what I've got for ${name}:\n\n"${composedBody}"\n\n` +
              `Does that work? Say yes and I'll hand it off to your Messages app so you can tap Send.`;
          } catch (err) {
            log.warn({ err }, "[chatHandlerCore] send_sms inline compose failed");
            setPendingText(sessionUserName, {
              phase:          "awaiting_intent",
              recipientName:  name,
              recipientPhone: phone,
              tone,
            });
            finalReply = `What would you like to say to ${name}?`;
          }
        } else {
          // Genuinely nothing to go on yet ("text Susan" with no other content) — ask
          setPendingText(sessionUserName, {
            phase:          "awaiting_intent",
            recipientName:  name,
            recipientPhone: phone,
            tone,
          });
          finalReply = `What would you like to say to ${name}?`;
        }
        log.info({ recipientName: name, hasPhone: !!phone, composedInline: !!inlineIntent }, "[chatHandlerCore] SMS flow started");
      }
      break;
    }

    // ── sms_send ──────────────────────────────────────────────────────────────
    case "sms_send": {
      const pending = getPendingText(sessionUserName);
      const overrideBody = action.body?.trim() || null;
      const body = overrideBody || pending?.composedBody;
      if (pending && body) {
        const phone = pending.recipientPhone ?? "";
        const cleanPhone = phone ? sanitizePhone(phone) : "";
        const bodySep = "?";
        const encodedBody = encodeURIComponent(body);
        const smsUri = cleanPhone
          ? `sms:${cleanPhone}${bodySep}body=${encodedBody}`
          : `sms:?body=${encodedBody}`;
        smsPayload = {
          phone: cleanPhone,
          body,
          recipient: pending.recipientName,
          smsUri,
          relationship: pending.relationship,
          tone: pending.tone,
        };
        setPendingText(sessionUserName, null);
        setLastSmsPayload(sessionUserName, smsPayload);
        log.info({ recipient: pending.recipientName, usedOverride: !!overrideBody }, "[chatHandlerCore] SMS confirmed and built");
      }
      break;
    }

    // ── sms_revise ────────────────────────────────────────────────────────────
    case "sms_revise": {
      const pending = getPendingText(sessionUserName);
      if (pending?.composedBody) {
        try {
          const { body: revisedBody } = await composeTextMessage({
            recipientName: pending.recipientName,
            relationship:  pending.relationship,
            tone:          pending.tone,
            userIntent:    `Previous draft: "${pending.composedBody}". User's feedback: "${action.feedback ?? message}"`,
            senderName:    userProfile?.name ?? sessionUserName,
          });
          setPendingText(sessionUserName, { ...pending, composedBody: revisedBody });
          finalReply = `Here's the revised version: "${revisedBody}" — does that work?`;
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] SMS revision failed");
          finalReply = "Sorry, I had trouble revising that. Can you try again?";
        }
      }
      break;
    }

    // ── sms_cancel ────────────────────────────────────────────────────────────
    case "sms_cancel": {
      if (getPendingText(sessionUserName)) {
        setPendingText(sessionUserName, null);
        finalReply = "No problem, I've dropped it.";
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
      finalReply = "Let me pull up your inbox...";

      // Starting a fresh triage pass is a clear signal any still-open reply
      // draft from a previous pass was abandoned — drop it now rather than
      // let it keep getting injected into this new session's turns.
      if (pendingEmailReply !== null) {
        setPendingEmailReply(sessionUserName, null);
        log.info({ droppedGmailId: pendingEmailReply.gmailId }, "[chatHandlerCore] Dropped stale pending email draft — starting a fresh check_email");
      }

      const companionDisplayName = getCompanionDisplayName(
        userProfile?.companionPersona ?? null,
        userProfile?.companionName ?? null
      );

      (async () => {
        try {
          const emails = await fetchAndSummarizeEmails(15, undefined, sessionUserName);

          if (!emails || emails.length === 0) {
            broadcastToUser(sessionUserName, "email_digest", {
              type: "email_digest",
              text: "Your inbox is clear — no unread emails right now.",
              totalCount: 0,
            });
            broadcastToUser(sessionUserName, "speak_sync", {
              text: "Your inbox is clear — no unread emails right now.",
              messageId: `email-${Date.now()}`,
              initiated_by: null,
            });
            return;
          }

          // Build digest summary via Haiku
          const emailList = emails.map((e, i) =>
            `${i + 1}. From: ${e.from} | Subject: ${e.subject}`
          ).join('\n');

          const digestReply = await anthropic.messages.create({
            model: MODEL_HAIKU,
            max_tokens: 150,
            system: `You are ${companionDisplayName}. Give a very brief, warm, natural summary of the user's inbox — just the count and whether anything looks important. 2 sentences maximum. No bullet points. No action tags.`,
            messages: [{ role: "user", content: `My unread emails:\n${emailList}` }],
          });

          const digestText = digestReply.content[0]?.type === "text"
            ? digestReply.content[0].text.replace(/\n?\[ACTION:[^\]]+\]/g, "").trim()
            : `You've got ${emails.length} unread emails.`;

          // Start triage session
          setTriageSession(sessionUserName, {
            emails,
            currentIndex: 0,
            createdAt: Date.now(),
          });

          const firstEmail = emails[0];

          // Push digest
          broadcastToUser(sessionUserName, "email_digest", {
            type: "email_digest",
            text: digestText,
            totalCount: emails.length,
          });
          broadcastToUser(sessionUserName, "speak_sync", {
            text: digestText,
            messageId: `email-digest-${Date.now()}`,
            initiated_by: null,
          });

          // Push first email card
          broadcastToUser(sessionUserName, "email_card", {
            type: "email_card",
            gmailId: firstEmail.gmailId,
            from: firstEmail.from,
            subject: firstEmail.subject,
            snippet: firstEmail.snippet,
            index: 1,
            total: emails.length,
          });
          log.info({ count: emails.length }, "[check_email] Digest and first card pushed via SSE");
        } catch (err) {
          log.warn({ err }, "[check_email] Failed");
          broadcastToUser(sessionUserName, "email_digest", {
            type: "email_digest",
            text: "I had trouble checking your email. Please try again.",
            totalCount: 0,
          });
        }
      })();

      break;
    }

    // ── email_action ─────────────────────────────────────────────────────────
    case "email_action": {
      if (action.gmailId && action.emailAction) {
        // Acting on a DIFFERENT email than a still-open reply draft is a clear
        // signal the user moved on without resolving it — drop it now instead
        // of leaving it to keep getting silently injected into every future
        // turn for the rest of its TTL (see [Pending Email Draft] above).
        if (pendingEmailReply !== null && pendingEmailReply.gmailId !== action.gmailId) {
          setPendingEmailReply(sessionUserName, null);
          log.info({ droppedGmailId: pendingEmailReply.gmailId }, "[chatHandlerCore] Dropped stale pending email draft — user moved to a different email");
        }

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

        // Advance to next email after action
        const nextEmail = advanceTriageSession(sessionUserName);
        if (nextEmail) {
          const session = getTriageSession(sessionUserName);
          const cardIndex = (session?.currentIndex ?? 0) + 1;
          const cardTotal = session ? session.emails.length : 0;
          broadcastToUser(sessionUserName, "email_card", {
            type: "email_card",
            gmailId: nextEmail.gmailId,
            from: nextEmail.from,
            subject: nextEmail.subject,
            snippet: nextEmail.snippet,
            index: cardIndex,
            total: cardTotal,
          });
        } else {
          broadcastToUser(sessionUserName, "email_done", {
            type: "email_done",
            text: "You're all caught up — inbox handled!",
          });
          broadcastToUser(sessionUserName, "speak_sync", {
            text: "You're all caught up — inbox handled!",
            messageId: `email-done-${Date.now()}`,
            initiated_by: null,
          });
        }
      }
      break;
    }

    // ── email_reply ───────────────────────────────────────────────────────────
    case "email_reply": {
      if (action.gmailId) {
        const session = getTriageSession(sessionUserName);
        const emailToReply = session?.emails.find(e => e.gmailId === action.gmailId)
          ?? session?.emails[session?.currentIndex ?? 0]
          ?? null;

        if (emailToReply) {
          const displayName = userProfile?.name ?? sessionUserName;
          const companionDisplay = getCompanionDisplayName(
            userProfile?.companionPersona ?? null,
            userProfile?.companionName ?? null
          );

          // Auto-draft immediately from email context
          try {
            const autoDraft = await composeEmailReply(
              {
                from: emailToReply.from,
                fromEmail: emailToReply.fromEmail,
                subject: emailToReply.subject,
                proposedDateTimeStr: null,
                isOpenEnded: true,
              },
              `Read this email and draft the most appropriate, natural reply on behalf of ${displayName}: "${emailToReply.snippet}"`,
              displayName
            );

            setPendingEmailReply(sessionUserName, {
              gmailId: emailToReply.gmailId,
              gmailThreadId: emailToReply.gmailThreadId,
              to: emailToReply.fromEmail,
              recipientName: emailToReply.from,
              subject: emailToReply.subject.startsWith('Re:') ? emailToReply.subject : `Re: ${emailToReply.subject}`,
              draftBody: autoDraft,
              userName: sessionUserName,
              createdAt: Date.now(),
            });

            finalReply = `Here's a draft reply to ${emailToReply.from}:\n\n"${autoDraft}"\n\nDoes that work? Tell me if you'd like any changes, or say yes to send it.`;

            dynamicPrompt += `\n\n[Email Reply Draft for ${emailToReply.from}]\n` +
              `Subject: ${emailToReply.subject}\n` +
              `Auto-draft based on email context:\n"${autoDraft}"\n\n` +
              `Present this draft to ${displayName} naturally. Read it back. Then say:\n` +
              `"Does that work? You can also tell me what you'd like to say instead, or type your exact reply and say 'send that word for word'."\n` +
              `If they approve → emit [ACTION:email_send]\n` +
              `If they give direction or feedback → end your reply with [ACTION:email_revise|feedback=<their exact words>] — the server recomposes the draft, do not write the revision yourself\n` +
              `If they say 'send that word for word' or 'use exactly what I typed' → end your reply with [ACTION:email_send|body=<their exact typed text>]\n` +
              `If they cancel → emit [ACTION:email_cancel]`;

          } catch (err) {
            log.warn({ err }, "[email_reply] Auto-draft failed");
            dynamicPrompt += `\n\n[Email Reply — Draft Failed]\nTell ${displayName} you had trouble drafting a reply and ask what they'd like to say to ${emailToReply.from}.`;
            setPendingEmailReply(sessionUserName, {
              gmailId: emailToReply.gmailId,
              gmailThreadId: emailToReply.gmailThreadId,
              to: emailToReply.fromEmail,
              recipientName: emailToReply.from,
              subject: emailToReply.subject.startsWith('Re:') ? emailToReply.subject : `Re: ${emailToReply.subject}`,
              draftBody: '',
              userName: sessionUserName,
              createdAt: Date.now(),
            });
          }
        }
      }
      break;
    }

    // ── email_send ────────────────────────────────────────────────────────────
    case "email_send": {
      if (pendingEmailReply) {
        const subject = pendingEmailReply.subject ||
          `Following up — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        const body = action.body?.trim() || pendingEmailReply.draftBody;
        const mailtoUri =
          `mailto:${encodeURIComponent(pendingEmailReply.to)}` +
          `?subject=${encodeURIComponent(subject)}` +
          `&body=${encodeURIComponent(body)}`;
        emailPayload = {
          to: pendingEmailReply.to,
          recipientName: pendingEmailReply.recipientName,
          subject,
          body,
          mailtoUri,
        };
        broadcastToUser(sessionUserName, "email-compose", { type: "email_compose", ...emailPayload });
        clearPendingEmailReply(sessionUserName);

        // Advance triage to next email
        const nextEmail = advanceTriageSession(sessionUserName);
        if (nextEmail) {
          const session = getTriageSession(sessionUserName);
          broadcastToUser(sessionUserName, "email_card", {
            type: "email_card",
            gmailId: nextEmail.gmailId,
            from: nextEmail.from,
            subject: nextEmail.subject,
            snippet: nextEmail.snippet,
            index: (session?.currentIndex ?? 0) + 1,
            total: session ? session.emails.length : 0,
          });
          log.info({ gmailId: nextEmail.gmailId }, "[email_send] Advanced to next email card");
        } else {
          broadcastToUser(sessionUserName, "email_done", {
            type: "email_done",
            text: "You're all caught up — inbox handled!",
          });
          broadcastToUser(sessionUserName, "speak_sync", {
            text: "You're all caught up — inbox handled!",
            messageId: `email-done-${Date.now()}`,
            initiated_by: null,
          });
          log.info("[email_send] Triage complete");
        }

        clearPendingMeetingRequests(sessionUserName);
        finalReply = `The reply is ready. Your email app should open with it pre-filled for ${pendingEmailReply.recipientName} — hit send when you're ready. I can't send it directly; that part's yours.`;
        log.info({ to: pendingEmailReply.to }, "[chatHandlerCore] Email packaged for send");
      }
      break;
    }

    // ── email_revise ──────────────────────────────────────────────────────────
    case "email_revise": {
      if (pendingEmailReply) {
        const displayName = userProfile?.name ?? sessionUserName;
        try {
          const revised = await composeEmailReply(
            {
              from: pendingEmailReply.recipientName,
              fromEmail: pendingEmailReply.to,
              subject: pendingEmailReply.subject,
              proposedDateTimeStr: null,
              isOpenEnded: true,
            },
            `Previous draft: "${pendingEmailReply.draftBody}". User's feedback: "${action.feedback ?? message}"`,
            displayName,
          );
          setPendingEmailReply(sessionUserName, { ...pendingEmailReply, draftBody: revised });
          finalReply = `Here's the revised version: "${revised}" — does that work?`;
        } catch (err) {
          log.warn({ err }, "[chatHandlerCore] Email revision failed");
          finalReply = "Sorry, I had trouble revising that. Can you try again?";
        }
      }
      break;
    }

    // ── email_cancel ──────────────────────────────────────────────────────────
    case "email_cancel": {
      if (pendingEmailReply) {
        clearPendingEmailReply(sessionUserName);
        finalReply = "No problem, I've dropped it.";
      }
      break;
    }

    // ── email_compose ─────────────────────────────────────────────────────────
    case "email_compose": {
      const recipientName = action.recipientName?.trim() ?? "";
      if (recipientName) {
        const searchResult = await searchContacts(recipientName, sessionUserName)
          .catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
        const contact = searchResult.contacts[0] ?? null;
        const email = contact?.email ?? null;
        const name = contact?.name ?? recipientName;

        if (email) {
          // Store pending reply context so draft/confirm/send flow works
          setPendingEmailReply(sessionUserName, {
            gmailId: '',
            gmailThreadId: '',
            to: email,
            recipientName: name,
            subject: '',
            draftBody: '',
            userName: sessionUserName,
            createdAt: Date.now(),
          });
          dynamicPrompt += `\n\n[Email Compose — ${name} (${email})]\nThe user wants to compose a new email to ${name}. Ask them what they'd like to say, or offer to draft something based on context. Once you know what they want to say, end your reply with [ACTION:email_revise|feedback=<what they want to say, in their words>] — the server writes the actual draft from that and shows it next turn; do not write the draft yourself here, it will not be saved. Once a draft has been shown, handle confirmation naturally: approve → [ACTION:email_send]; more changes → [ACTION:email_revise|feedback=<their words>]; cancel → [ACTION:email_cancel].`;
        } else {
          finalReply = `I couldn't find an email address for ${name} in your contacts. Can you provide their email address?`;
        }
      }
      break;
    }

    // ── email_next ────────────────────────────────────────────────────────────
    case "email_next": {
      const nextEmail = advanceTriageSession(sessionUserName);
      if (nextEmail) {
        const session = getTriageSession(sessionUserName);
        const cardIndex = (session?.currentIndex ?? 0) + 1;
        const cardTotal = session ? session.emails.length : 0;
        broadcastToUser(sessionUserName, "email_card", {
          type: "email_card",
          gmailId: nextEmail.gmailId,
          from: nextEmail.from,
          subject: nextEmail.subject,
          snippet: nextEmail.snippet,
          index: cardIndex,
          total: cardTotal,
        });
        log.info({ gmailId: nextEmail.gmailId }, "[email_next] Next card pushed");
      } else {
        broadcastToUser(sessionUserName, "email_done", {
          type: "email_done",
          text: "You're all caught up — inbox handled!",
        });
        broadcastToUser(sessionUserName, "speak_sync", {
          text: "You're all caught up — inbox handled!",
          messageId: `email-done-${Date.now()}`,
          initiated_by: null,
        });
        log.info("[email_next] Triage complete");
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

    // generateDailyBrief() (Claude Sonnet + web_search tool) is the only
    // morning-briefing path now — the old cached/scheduled pre-generation
    // pipeline has been removed (was: _doBriefingPrefetch,
    // getPersistedBriefingText/Summary, getStaticBriefingContext).
    case "morning_rundown": {
      // Serve the version the scheduler pregenerated ~30 min before wake
      // time, if one's ready — skips a live ~60s Claude + web_search call
      // inside the user's own request. Falls through to live generation
      // below if nothing's cached yet (e.g. pregeneration hasn't run today,
      // or the user asks well outside their usual wake window).
      const { getTodaysCachedBriefing } = await import("../../morning/briefingCache.js");
      const cached = await getTodaysCachedBriefing(sessionUserName).catch(() => null);
      if (cached) {
        finalReply = cached;
        break;
      }

      // Ensure today's Stoic entry is settled BEFORE the brief reads it —
      // this is one of two real-engagement call sites (the other is
      // GET /api/stoic/today for My Life) sharing the same advance gate, so
      // whichever is opened first each day is the one that advances, and
      // the brief itself must read the post-advance value, not a stale one.
      const { ensureStoicDayCurrent } = await import("../../stoic/stoicManager.js");
      await ensureStoicDayCurrent(sessionUserName).catch((err) =>
        log.warn({ err }, "[chatHandlerCore] ensureStoicDayCurrent failed")
      );

      const { generateDailyBrief } = await import("../../morning/briefingPregenerate.js");
      const fresh = await generateDailyBrief(sessionUserName).catch((err) => {
        log.warn({ err }, "[chatHandlerCore] generateDailyBrief failed");
        return null;
      });
      if (fresh) {
        finalReply = fresh;
      } else {
        finalReply = "I had trouble putting together your briefing just now — give it another try in a moment.";
      }
      break;
    }

    // ── local_activity_search ─────────────────────────────────────────────────
    // Ad-hoc "what should I do this weekend" type questions. Previously these
    // fell through to "none" and got a generic, unpersonalized web_search
    // reply — confirmed live, it surfaced big-name touring concerts with no
    // connection to the user's actual interests. Reuses the same
    // three-source-gathering + personalized-ranking pipeline the scheduled
    // Monday/Thursday push already uses (proactiveEventScheduler.ts), so
    // this gets the identical quality bar. Formatted directly here (not a
    // second model call) so a real link is never optional/forgotten the way
    // it was for the scheduled picks before that got fixed.
    case "local_activity_search": {
      const { searchLocalActivities } = await import("../../morning/proactiveEventScheduler.js");
      const runContext = action.localActivityContext ?? "week";
      try {
        const result = await searchLocalActivities(sessionUserName, runContext);
        if (!result) {
          finalReply = "I don't have a city on file for you yet — once that's set I can look this up.";
        } else if (result.picks.length === 0) {
          finalReply = "I looked, but nothing genuinely matched what you're into right now — want me to check again in a few days, or broaden what I search for?";
        } else {
          const emoji: Record<string, string> = { event: "🎵", activity: "📍", restaurant: "🍽️" };
          const lines = result.picks.map((p) => {
            const c = p.candidate;
            const when = c.dateLabel || c.dateISO || "ongoing";
            const where = c.venue ? ` at ${c.venue}` : "";
            const link = c.url ? ` [More info](${c.url})` : "";
            return `${emoji[c.category] ?? "•"} **${c.name}**${where} — ${when}. ${p.reason}${link}`;
          });
          finalReply = `Here's what I found in ${result.city}:\n\n${lines.join("\n\n")}`;
        }
      } catch (err) {
        log.warn({ err }, "[chatHandlerCore] searchLocalActivities failed");
        finalReply = "I had trouble pulling that together just now — give it another try in a moment.";
      }
      break;
    }

  }

  // ── Wind-down reflection capture ─────────────────────────────────────────────
  // Only persist as a genuine reflection once we know Claude treated this as a
  // plain conversational reply (action.type === "none") — not a reminder,
  // reservation, list add, or anything else that already has its own destination.
  // Fire-and-forget: never blocks the response already being returned below.
  if (winddownReplyClaimed && action.type === "none") {
    saveLifeCapture(sessionUserName, message, "evening", winddownStoicPhase).then((capture) => {
      if (capture) {
        runConnectionEngine(sessionUserName, "capture").catch((err) => log.warn({ err }, "[chatHandlerCore] runConnectionEngine failed"));
      }
    }).catch((err) => log.warn({ err }, "[chatHandlerCore] Winddown reflection capture failed"));
  }

  // ── Post-processing ──────────────────────────────────────────────────────────
  const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  runPostProcessing(sessionUserName, message, finalReply, history, userProfile, deviceId, messageId);

  return { reply: finalReply, action, smsPayload, reservationPayload, navigationUrl, messageId, emailPayload };
}

// ── Post-processing ───────────────────────────────────────────────────────────

function runPostProcessing(
  userName:    string,
  userMessage: string,
  aiReply:     string,
  history:     Array<{ role: string; content: string }>,
  userProfile: UserProfile | null,
  deviceId:    string | null,
  msgId:       string
): void {
  const companionName = getCompanionDisplayName(
    userProfile?.companionPersona ?? null,
    userProfile?.companionName ?? null
  );

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
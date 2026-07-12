import {
  fetchAndSummarizeEmails,
  formatEmailsForPrompt,
  buildImportantEmailInstruction,
  updateEmailLastChecked,
  trashEmail,
  archiveEmail,
  markEmailRead,
  type EmailSummary,
} from "../../google/gmail.js";
import {
  fetchWeekEvents,
  formatCalendarForPrompt,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventByKeywords,
  findEventForUpdate,
  checkCalendarConflict,
} from "../../google/calendar.js";
import {
  parseCalendarOperation,
  setPendingDelete,
  getPendingDelete,
  clearPendingDelete,
  formatEventConfirmation,
  type ParsedCreateEvent,
  type ParsedModifyEvent,
  type ParsedDeleteEvent,
} from "../../google/calendarWriter.js";
import { hasCalendarWriteScope } from "../../google/oauth.js";
import {
  detectMeetingRequests,
  buildMeetingRequestsBlock,
  buildPendingRepliesBlock,
  getPendingMeetingRequests,
  setPendingMeetingRequests,
  getPendingReplyEmails,
  composeEmailReply,
  clearPendingMeetingRequests,
  setPendingEmailReply,
  clearPendingEmailReply,
  type EmailInput,
  type DetectedMeetingRequest,
  type PendingEmailReply,
} from "../../email/emailMeetingManager.js";
import type { UserProfile } from "../../onboarding/onboardingManager.js";
import { getCurrentDateTimeBlock } from "../getCurrentDateTimeBlock.js";
import { classifyConfirmationIntent } from "../../text/textMessageComposer.js";

export interface EmailCalendarResult {
  contextBlock: string;
  hardcodedResponse?: string;
  emailPayload?: {
    to: string;
    recipientName: string;
    subject: string;
    body: string;
    mailtoUri: string;
  };
}

export interface HandleEmailCalendarParams {
  message: string;
  sessionUserName: string;
  timezone: string;
  corePrompt: string;
  memoryBlock: string;
  isDinnerTonightQuery: boolean;
  isEmailRequest: boolean;
  isCalendarRequest: boolean;
  isCalendarWriteOp: boolean;
  isDeleteConfirm: boolean;
  isDeleteCancel: boolean;
  isCalendarCreate: boolean;
  isCalendarModify: boolean;
  isCalendarDelete: boolean;
  isEmailReplyFlowActive: boolean;
  isEmailReplyAccepted: boolean;
  pendingMeetingRequests: DetectedMeetingRequest[];
  pendingEmailReply: PendingEmailReply | null;
  userProfile: UserProfile | null;
  log: { warn: (obj: object, msg?: string) => void; info: (obj: object, msg?: string) => void };
}

export async function handleEmailCalendar(params: HandleEmailCalendarParams): Promise<EmailCalendarResult> {
  const {
    message,
    sessionUserName,
    timezone,
    corePrompt,
    memoryBlock,
    isDinnerTonightQuery,
    isEmailRequest,
    isCalendarRequest,
    isCalendarWriteOp,
    isDeleteConfirm,
    isDeleteCancel,
    isCalendarCreate,
    isCalendarModify,
    isCalendarDelete,
    isEmailReplyFlowActive,
    isEmailReplyAccepted,
    pendingMeetingRequests,
    pendingEmailReply,
    userProfile,
    log,
  } = params;

  let contextBlock = "";
  let hardcodedResponse: string | undefined;
  let emailPayload: EmailCalendarResult["emailPayload"];

  // Accumulates E007 content so it survives a contextBlock rebuild below.
  let e007Block = "";

  // ── E007-CONF: Email reply confirmed — package for email app ──────────────
  if (isEmailReplyFlowActive && pendingEmailReply) {
    const displayName = userProfile?.name ?? sessionUserName;
    const confirmIntent = await classifyConfirmationIntent(message);
    if (confirmIntent === "send") {
      const mailtoUri =
        `mailto:${encodeURIComponent(pendingEmailReply.to)}` +
        `?subject=${encodeURIComponent(pendingEmailReply.subject)}` +
        `&body=${encodeURIComponent(pendingEmailReply.draftBody)}`;
      emailPayload = {
        to: pendingEmailReply.to,
        recipientName: pendingEmailReply.recipientName,
        subject: pendingEmailReply.subject,
        body: pendingEmailReply.draftBody,
        mailtoUri,
      };
      clearPendingEmailReply(sessionUserName);
      clearPendingMeetingRequests(sessionUserName);
      hardcodedResponse = `The reply is ready. Your email app should open with it pre-filled for ${pendingEmailReply.recipientName} — hit send when you're ready. I can't send it directly; that part's yours.`;
      log.info({ to: pendingEmailReply.to }, "[E007-CONF] Email packaged — hardcoded response");
    } else if (confirmIntent === "cancel") {
      clearPendingEmailReply(sessionUserName);
      e007Block += `\n\n[Email Reply Cancelled]\nUser cancelled. Acknowledge: "No problem, I've dropped it."`;
    } else {
      try {
        const revised = await composeEmailReply(
          {
            from: pendingEmailReply.recipientName,
            fromEmail: pendingEmailReply.to,
            subject: pendingEmailReply.subject,
            proposedDateTimeStr: null,
            isOpenEnded: true,
          },
          `Previous draft: "${pendingEmailReply.draftBody}". User's feedback: "${message}"`,
          displayName,
        );
        setPendingEmailReply(sessionUserName, { ...pendingEmailReply, draftBody: revised });
        e007Block +=
          `\n\n[Email Reply Revised]\nDraft:\n"${revised}"\n\n` +
          `Read the revised reply word for word, then ask: ` +
          `"Does that work? Say yes and I'll hand it off to your email app." ` +
          `CRITICAL: You cannot send it — the email app opens only AFTER they confirm.`;
      } catch (err) {
        log.warn({ err }, "[E007-CONF] Revision failed");
      }
    }
  }

  // ── E007-MEET: Email meeting request — user accepted, compose draft ─────────
  if (isEmailReplyAccepted && pendingMeetingRequests.length > 0) {
    const displayName = userProfile?.name ?? sessionUserName;
    const request = pendingMeetingRequests[0];
    const timeHintMatch = /suggest\s+(.+)|prefer\s+(.+)|how\s+about\s+(.+)|what\s+about\s+(.+)/i.exec(message);
    const timeHint = timeHintMatch?.[1] ?? timeHintMatch?.[2] ?? timeHintMatch?.[3] ?? timeHintMatch?.[4] ?? null;
    const intent =
      request.isOpenEnded
        ? `Reply positively and suggest a time to meet${timeHint ? `: ${timeHint}` : " — pick something that sounds reasonable from the calendar context"}`
        : request.calendarStatus === "conflict" && request.suggestedAlternative
          ? `Apologize that ${request.proposedDateTimeStr} doesn't work, suggest ${timeHint ?? request.suggestedAlternative} instead`
          : `Confirm that ${timeHint ?? request.proposedDateTimeStr} works great`;
    try {
      const draftBody = await composeEmailReply(request, intent, displayName);
      const replySubject = request.subject.startsWith("Re:") ? request.subject : `Re: ${request.subject}`;
      setPendingEmailReply(sessionUserName, {
        gmailId: request.gmailId,
        gmailThreadId: request.gmailThreadId,
        to: request.fromEmail,
        recipientName: request.from,
        subject: replySubject,
        draftBody,
        userName: sessionUserName,
        createdAt: Date.now(),
      });
      e007Block +=
        `\n\n[Email Reply Drafted for ${request.from}]\n` +
        `Reply to: ${request.fromEmail}\n` +
        `Subject: ${replySubject}\n` +
        `Draft:\n"${draftBody}"\n\n` +
        `Read this reply to ${displayName} word for word, then ask: ` +
        `"Want me to hand that off to your email app?" ` +
        `CRITICAL HONESTY RULES: ` +
        `(1) You are composing only — you CANNOT send it directly. ` +
        `(2) The email app opens AFTER they say yes. Do NOT say it is opening now. ` +
        `(3) Never say "sending now", "opening your email", or imply immediate action.`;
      log.info({ to: request.fromEmail }, "[E007-MEET] Reply drafted — awaiting confirmation");
    } catch (err) {
      log.warn({ err }, "[E007-MEET] Reply composition failed");
      e007Block += `\n\n[Email Reply — Error]\nTell ${displayName} you had trouble drafting the reply and ask them to try again.`;
    }
  }

  // ── Email / calendar context fetch ─────────────────────────────────────────
  if (isEmailRequest || isCalendarRequest) {
    try {
      const [emails, events] = await Promise.all([
        isEmailRequest
          ? fetchAndSummarizeEmails(15, undefined, sessionUserName).catch(() => null)
          : Promise.resolve(undefined),
        (isEmailRequest || isCalendarRequest)
          ? fetchWeekEvents(true, sessionUserName).catch(() => null)
          : Promise.resolve(undefined),
      ]);

      if (isEmailRequest && emails !== null) {
        updateEmailLastChecked().catch(() => {});
      }

      // ── On-demand meeting detection ────────────────────────────────────────
      // Gap 3: skip if fresh meeting requests already exist for this user.
      const hasFreshMeetingRequests = getPendingMeetingRequests(sessionUserName).length > 0;
      let onDemandMeetingBlock = "";
      if (isEmailRequest && Array.isArray(emails) && emails.length > 0 && !hasFreshMeetingRequests) {
        try {
          const emailsForDetection: EmailInput[] = emails.map((e) => ({
            gmailId: e.gmailId,
            gmailThreadId: e.gmailThreadId,
            from: e.from,
            fromEmail: e.fromEmail,
            subject: e.subject,
            snippet: e.snippet,
          }));
          const calendarEventsForDetection = Array.isArray(events) ? events : [];
          const detected = await Promise.race([
            detectMeetingRequests(emailsForDetection, calendarEventsForDetection),
            new Promise<Awaited<ReturnType<typeof detectMeetingRequests>>>((resolve) =>
              setTimeout(() => resolve([]), 3000)
            ),
          ]);
          if (detected.length > 0) {
            setPendingMeetingRequests(sessionUserName, detected);
            onDemandMeetingBlock = buildMeetingRequestsBlock(detected, sessionUserName);
            log.info({ count: detected.length }, "[E007] On-demand meeting requests detected");
          }
        } catch (err) {
          log.warn({ err }, "[E007] On-demand meeting detection failed — skipping");
        }
      }

      // ── Assemble context blocks ────────────────────────────────────────────
      const gmailBlock =
        emails !== undefined && emails !== null
          ? emails.length === 0
            ? `\n\n[VERIFIED — Gmail API — no unread emails in inbox]\nTell the user warmly: "Your inbox is clear — no unread emails right now." Do not elaborate.`
            : `\n\n[VERIFIED — Gmail API — recent unread emails (live fetch)]\n${formatEmailsForPrompt(emails)}\nThis is VERIFIED data. State email senders, subjects, and content as fact exactly as shown. Do not add context not present in the email data.` +
              buildImportantEmailInstruction(emails, userProfile?.companionName, sessionUserName)
          : emails === null
          ? "\n\n[Gmail — not connected. Let the user know they can connect Google in the app header.]"
          : "";

      const dinnerCalendarNote = isDinnerTonightQuery
        ? `\n\nDINNER / TONIGHT RULES — ABSOLUTE:\n• Scan the calendar data above for any event today that contains a restaurant name, location, or dinner reference.\n• If you find one: reference that specific event title and time. e.g. "You've got dinner at Bolla at 7:30 tonight."\n• If there is nothing on the calendar today that looks like a dinner or evening plan: say exactly that — "Nothing on your calendar for tonight" or "I don't see any dinner plans on your calendar." Do NOT guess, invent, or suggest a restaurant name. Do NOT say "I believe you're going to…" or anything speculative.\n• Never name a restaurant or location unless it appears verbatim in a calendar event title or event location field above.`
        : "";

      const calendarBlock =
        events !== undefined && events !== null
          ? `\n\n[VERIFIED — Google Calendar API — next 7 days]\n${formatCalendarForPrompt(events, "this week")}\n\nCONFIDENCE RULES FOR THIS DATA:\n• VERIFIED: Use the exact event title, time, and date as shown above — state these as fact.\n• INFERRED: If you want to add context (e.g., who the appointment might be with), frame it as a question — never a statement. Say: "I see 'Acme Corp Meeting' on Thursday — is that the one you mentioned?" NOT "You have a meeting with John from Acme Thursday."\n• ASSUMED: Do not state who an appointment is with, whether it recurs, or any other detail not explicitly in the title above.\n\nAnswer the user's question about their schedule conversationally — do NOT read out a list of bullet points. Speak naturally. If they asked about today, focus on today. If they asked about the week, give a flowing narrative overview. If the calendar is clear, say so warmly.\n\nTRIP PLANNING RULE: If the conversation involves planning a trip with specific departure and return dates, ONLY flag calendar events as conflicts if they fall ON or AFTER the departure date AND ON or BEFORE the return date. Events scheduled before the departure date are irrelevant to the trip and must NOT be mentioned as conflicts — the user will still attend them as normal.${dinnerCalendarNote}`
          : events === null
          ? "\n\n[Google Calendar — not connected. Let the user know they can connect Google in the app header.]"
          : "";

      const pendingRepliesBlock = buildPendingRepliesBlock(getPendingReplyEmails(sessionUserName), sessionUserName);

      // Rebuild contextBlock as the full system prompt for email/calendar responses.
      // Any e007Block content is appended at the end so it survives this rebuild.
      contextBlock =
        getCurrentDateTimeBlock(timezone) + "\n" +
        corePrompt +
        memoryBlock +
        gmailBlock +
        onDemandMeetingBlock +
        pendingRepliesBlock +
        calendarBlock +
        e007Block;
    } catch (err) {
      log.warn({ err }, "On-demand email/calendar fetch failed");
    }
  } else {
    // No email/calendar fetch — just carry e007Block forward for the caller to append.
    contextBlock = e007Block;
  }

  // ── Calendar write operations (create / modify / delete) ────────────────────
  if (isDeleteConfirm || isDeleteCancel) {
    const pd = getPendingDelete(sessionUserName);
    if (!pd) {
      // Gap 6: confirmation window expired — inform gracefully rather than throwing
      contextBlock += `\n\n[Calendar Delete — Confirmation Expired]\nThe delete confirmation window has expired (5 minutes). Tell the user warmly: "That confirmation window has closed — if you still want to cancel that event, just ask me again and I'll pull it up."`;
    } else if (isDeleteConfirm) {
      try {
        await deleteCalendarEvent(pd.eventId, sessionUserName);
        clearPendingDelete(sessionUserName);
        contextBlock +=
          `\n\n[Calendar Event Deleted]\n"${pd.summary}" on ${pd.dateLabel} has been permanently removed from the user's Google Calendar.\nConfirm warmly and briefly — e.g. "Done — I've cancelled your ${pd.summary} on ${pd.dateLabel}."`;
        log.info({ eventId: pd.eventId, summary: pd.summary }, "Calendar event deleted");
      } catch (err) {
        clearPendingDelete(sessionUserName);
        log.warn({ err }, "Calendar delete failed");
        contextBlock += `\n\n[Calendar Delete Failed]\nTell the user the delete failed and they can try again or do it manually in Google Calendar.`;
      }
    } else {
      clearPendingDelete(sessionUserName);
      contextBlock += `\n\n[Calendar Delete Cancelled]\nDavid chose NOT to delete "${pd.summary}". Acknowledge warmly — e.g. "Got it, keeping your ${pd.summary} on the calendar."`;
    }
  } else if (isCalendarWriteOp) {
    const hasWriteScope = await hasCalendarWriteScope(sessionUserName).catch(() => false);
    if (!hasWriteScope) {
      contextBlock +=
        `\n\n[Calendar Write — Insufficient Permission]\nThe user's current Google connection only has read-only calendar access. To create, edit, or delete events, they need to reconnect Google to grant the updated permission. Tell them this warmly — e.g. "I'd love to add that for you, but I need a quick update to my Google permissions first. Just tap the Google button in the header to reconnect — it only takes a second."`;
    } else if (isCalendarCreate) {
      try {
        const parsed = await parseCalendarOperation(message, "create") as ParsedCreateEvent | null;
        if (!parsed) throw new Error("parse failed");

        if (parsed.ambiguous && parsed.clarificationNeeded) {
          contextBlock += `\n\n[Calendar Create — Clarification Needed]\nAsk the user: "${parsed.clarificationNeeded}" — before creating the event.`;
        } else {
          // Gap 4: check for conflicts before creating
          let conflictWarning = "";
          if (parsed.date && parsed.startTime && !parsed.allDay) {
            const conflict = await checkCalendarConflict(
              sessionUserName,
              parsed.date,
              parsed.startTime
            ).catch(() => null);
            if (conflict) {
              conflictWarning = `\n\nHEADS UP — CONFLICT DETECTED: There is already "${conflict}" on the calendar at that time. Mention this to the user before confirming the new event was added. Say something like "Just so you know, you already have [conflict] at that time — I've added [new event] anyway, but worth a look."`;
            }
          }

          const created = await createCalendarEvent({
            title: parsed.title,
            date: parsed.date,
            startTime: parsed.startTime,
            endTime: parsed.endTime,
            location: parsed.location,
            description: parsed.description,
            allDay: parsed.allDay,
          }, sessionUserName);

          if (created) {
            const confirmation = formatEventConfirmation({
              title: parsed.title,
              date: parsed.date,
              startTime: parsed.startTime,
              endTime: parsed.endTime,
              location: parsed.location,
              allDay: parsed.allDay,
            });
            let calendarCreateMsg =
              `\n\n[Calendar Event Created]\n"${confirmation}" has been added to the user's Google Calendar.\nConfirm warmly and specifically — read it back exactly: "I've added ${confirmation}."`;
            if (parsed.location) {
              calendarCreateMsg +=
                `\n\nThis event has a location: "${parsed.location}". After confirming the event was added, automatically offer TWO things (both in the same message, not separately):\n` +
                `1. DEPARTURE ALERT: "Want me to set a departure alert? I can calculate the drive time from home and remind you when to leave." If they say yes, calculate approximate drive time from the user's home and set a reminder to leave in time.\n` +
                `2. SAVED PLACE: "Want me to save ${parsed.location} to your saved places so you don't need the address next time?" If they say yes, save the location name and address to their Winston profile.\n` +
                `Offer BOTH options in a single natural sentence, e.g. "Want me to set a departure alert and save ${parsed.location.split(",")[0]} to your saved places?"`;
            } else {
              calendarCreateMsg += ` Then ask if they'd also like a reminder for it.`;
            }
            calendarCreateMsg += conflictWarning;
            contextBlock += calendarCreateMsg;
            log.info({ title: parsed.title, date: parsed.date }, "Calendar event created");
          } else {
            contextBlock += `\n\n[Calendar Create Failed]\nTell the user the event couldn't be created and suggest he check Google Calendar or try again.`;
          }
        }
      } catch (err) {
        log.warn({ err }, "Calendar create failed");
        contextBlock += `\n\n[Calendar Create — Parse Error]\nTell the user you had trouble understanding the event details and ask them to repeat with the date and time.`;
      }
    } else if (isCalendarModify) {
      try {
        const parsed = await parseCalendarOperation(message, "modify") as ParsedModifyEvent | null;
        if (!parsed) throw new Error("parse failed");

        // Gap 5: findEventForUpdate returns CalendarEvent[] | null for disambiguation
        const matchedEvents = await findEventForUpdate(parsed.searchKeywords);

        if (!matchedEvents || matchedEvents.length === 0) {
          contextBlock += `\n\n[Calendar Modify — Event Not Found]\nTell the user you couldn't find "${parsed.searchKeywords}" in their calendar. Ask them to double-check the event name or tell you the date it's on.`;
        } else if (matchedEvents.length > 1) {
          const eventList = matchedEvents
            .map((e, i) => `${i + 1}. "${e.summary}" on ${e.dateLabel}${e.start ? ` at ${e.start}` : ""}`)
            .join("\n");
          contextBlock += `\n\n[Calendar Modify — Multiple Events Found]\nFound ${matchedEvents.length} events matching "${parsed.searchKeywords}":\n${eventList}\n\nAsk the user which one they mean — e.g. "I found a few events that could match — which one did you want to change?" and list them.`;
        } else {
          const event = matchedEvents[0];
          const updated = await updateCalendarEvent(event.id, {
            title: parsed.newTitle,
            date: parsed.newDate,
            startTime: parsed.newStartTime,
            endTime: parsed.newEndTime,
            location: parsed.newLocation,
          }, sessionUserName);

          if (updated) {
            const newDate = parsed.newDate ?? event.isoDate;
            const confirmation = formatEventConfirmation({
              title: parsed.newTitle ?? event.summary,
              date: newDate,
              startTime: parsed.newStartTime,
              location: parsed.newLocation ?? event.location,
            });
            contextBlock +=
              `\n\n[Calendar Event Updated]\n"${event.summary}" has been moved/updated using events.patch (NOT insert).\nConfirm specifically: "Done — ${confirmation} is all set." Read the new details back naturally.`;
            log.info({ eventId: event.id, summary: event.summary }, "Calendar event updated via events.patch");
          } else {
            contextBlock += `\n\n[Calendar Update Failed]\nTell the user the update failed and suggest they try again or edit in Google Calendar directly.`;
          }
        }
      } catch (err) {
        log.warn({ err }, "Calendar modify failed");
        contextBlock += `\n\n[Calendar Modify — Parse Error]\nTell the user you had trouble identifying which event to change, and ask them to describe it with more detail (name and current date).`;
      }
    } else if (isCalendarDelete) {
      try {
        const parsed = await parseCalendarOperation(message, "delete") as ParsedDeleteEvent | null;
        if (!parsed) throw new Error("parse failed");

        const event = await findEventByKeywords(parsed.searchKeywords, parsed.searchDate);
        if (!event) {
          contextBlock += `\n\n[Calendar Delete — Event Not Found]\nTell the user you couldn't find "${parsed.searchKeywords}" in their calendar for the next 7 days.`;
        } else {
          setPendingDelete(sessionUserName, {
            eventId: event.id,
            summary: event.summary,
            dateLabel: event.dateLabel,
            startTime: event.start,
            location: event.location,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
          contextBlock +=
            `\n\n[Calendar Delete — Awaiting Confirmation]\nDavid wants to cancel: "${event.summary}" on ${event.dateLabel}${event.start ? ` at ${event.start}` : ""}${event.location ? ` at ${event.location}` : ""}.\nAsk for confirmation: "I found your ${event.summary} on ${event.dateLabel}${event.start ? ` at ${event.start}` : ""}. Shall I go ahead and cancel it?" — wait for his yes or no before deleting.`;
          log.info({ eventId: event.id, summary: event.summary }, "Calendar delete pending confirmation");
        }
      } catch (err) {
        log.warn({ err }, "Calendar delete parse failed");
        contextBlock += `\n\n[Calendar Delete — Parse Error]\nTell the user you had trouble identifying which event to cancel, and ask them to be more specific.`;
      }
    }
  }

  return { contextBlock, hardcodedResponse, emailPayload };
}

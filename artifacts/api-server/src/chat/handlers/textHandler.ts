import { broadcastToUser } from "../../reminders/sseStore.js";
import {
  composeTextMessage,
  sanitizeSmsBody,
  detectToneFromRelationship,
  detectToneOverride,
  toneLabel,
  setPendingText,
  classifyConfirmationIntent,
  setLastSmsPayload,
  type MessageTone,
  type TextContactCandidate,
  type PendingTextState,
  type SmsPayload,
} from "../../text/textMessageComposer.js";
import type { UserProfile } from "../../onboarding/onboardingManager.js";

export interface TextResult {
  contextBlock: string;
  hardcodedResponse?: string;
  smsPayload?: SmsPayload;
}

export interface HandleTextParams {
  message: string;
  sessionUserName: string;
  deviceId: string | null;
  isTextFlowActive: boolean;
  pendingText: PendingTextState | null;
  isSmsRetryRequest: boolean;
  isSmsEditAfterSend: boolean;
  lastSmsPayload: SmsPayload | null;
  userProfile: UserProfile | null;
  log: { warn: (obj: object, msg?: string) => void; info: (obj: object, msg?: string) => void };
}

function sanitizePhone(raw: string): string {
  const stripped = raw.replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(stripped)) return `+1${stripped}`;
  if (/^1\d{10}$/.test(stripped)) return `+${stripped}`;
  return stripped;
}

export async function handleText(params: HandleTextParams): Promise<TextResult> {
  const {
    message,
    sessionUserName,
    deviceId,
    isTextFlowActive,
    pendingText,
    isSmsRetryRequest,
    isSmsEditAfterSend,
    lastSmsPayload,
    userProfile,
    log,
  } = params;

  let contextBlock = "";
  let hardcodedResponse: string | undefined;
  let smsPayload: SmsPayload | undefined;

  // ── T006: Text message composition flow ────────────────────────────────────
  if (isTextFlowActive && pendingText) {
    const displayName = userProfile?.name ?? sessionUserName;
    const toneOverride = detectToneOverride(message);

    // ── T006-DISAMBIG: User is choosing which person to text ─────────────────
    if (pendingText.phase === "awaiting_disambiguation" && pendingText.candidates) {
      const candidates = pendingText.candidates;
      const lowerMsg = message.toLowerCase().trim();

      let resolved: TextContactCandidate | null = null;

      const ordinalMatch = lowerMsg.match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th)\b/);
      if (ordinalMatch) {
        const ordMap: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3 };
        const idx = ordMap[ordinalMatch[1]!] ?? -1;
        if (idx >= 0 && idx < candidates.length) resolved = candidates[idx]!;
      }

      if (!resolved) {
        resolved = candidates.find((c) =>
          lowerMsg.includes(c.name.toLowerCase()) ||
          (c.name.split(" ")[1] && lowerMsg.includes((c.name.split(" ")[1] ?? "").toLowerCase())) ||
          (c.relationship && lowerMsg.includes(c.relationship.toLowerCase()))
        ) ?? null;
      }

      if (resolved) {
        const inlineIntent = pendingText.inlineIntent;
        const hasInline = (inlineIntent?.length ?? 0) >= 10;
        const tone: MessageTone = detectToneFromRelationship(resolved.relationship ?? resolved.name);

        if (hasInline && inlineIntent) {
          try {
            const composed = await composeTextMessage({
              recipientName: resolved.name,
              relationship: resolved.relationship,
              tone,
              userIntent: inlineIntent,
              senderName: displayName,
            });
            setPendingText(sessionUserName, {
              phase: "awaiting_confirmation",
              recipientName: resolved.name,
              recipientPhone: resolved.phone,
              relationship: resolved.relationship,
              tone,
              composedBody: composed.body,
            });
            hardcodedResponse =
              `Here's what I've got for ${resolved.name}:\n\n"${composed.body}"\n\n` +
              `Does that work? Say yes and I'll hand it off to your Messages app so you can tap Send.`;
          } catch (compErr) {
            log.warn({ compErr }, "[T006-DISAMBIG] Inline composition after disambiguation failed");
            setPendingText(sessionUserName, { phase: "awaiting_intent", recipientName: resolved.name, recipientPhone: resolved.phone, relationship: resolved.relationship, tone });
            contextBlock += `\n\n[Text Message Flow — ${resolved.name} selected]\nAsk ${displayName} what they'd like to say to ${resolved.name}.`;
          }
        } else {
          setPendingText(sessionUserName, { phase: "awaiting_intent", recipientName: resolved.name, recipientPhone: resolved.phone, relationship: resolved.relationship, tone });
          const phoneNote = resolved.phone ? `Got ${resolved.name}'s number.` : `I don't have a number for ${resolved.name}, but I'll compose it and you can fill that in.`;
          contextBlock += `\n\n[Text Message Flow — ${resolved.name} selected]\n${phoneNote} Ask ${displayName} what they'd like to say.`;
        }
        log.info({ resolved: resolved.name, phone: !!resolved.phone }, "[T006-DISAMBIG] Candidate resolved");
      } else {
        const list = candidates.map((c, i) => {
          const rel = c.relationship ? ` (${c.relationship})` : "";
          const src = c.source === "key_people" ? " — from your key people" : "";
          return `${i + 1}. ${c.name}${rel}${src}`;
        }).join("\n");
        contextBlock +=
          `\n\n[Text Message — Disambiguation Needed Again]\n` +
          `Could not determine which person ${displayName} means. Options:\n${list}\n\n` +
          `Ask them to say the first name, last name, or "the first one" / "the second one".`;
        log.info({}, "[T006-DISAMBIG] Could not resolve — re-asking");
      }
    } else if (pendingText.phase === "awaiting_intent") {
      const effectiveTone: MessageTone = toneOverride ?? pendingText.tone;

      if (toneOverride !== null) {
        try {
          const composed = await composeTextMessage({
            recipientName: pendingText.recipientName,
            relationship: pendingText.relationship,
            tone: effectiveTone,
            userIntent: message,
            senderName: displayName,
          });

          setPendingText(sessionUserName, {
            ...pendingText,
            phase: "awaiting_confirmation",
            tone: effectiveTone,
            composedBody: composed.body,
          });

          hardcodedResponse =
            `Here's a ${toneLabel(effectiveTone)} version for ${pendingText.recipientName}:\n\n"${composed.body}"\n\n` +
            `Does that work? Say yes and I'll hand it off to your Messages app.`;

          log.info({ recipient: pendingText.recipientName, tone: effectiveTone }, "[T006] Intent with tone — composed via Claude");
        } catch (err) {
          log.warn({ err }, "[T006] Tone compose failed");
          setPendingText(sessionUserName, null);
          contextBlock += `\n\n[Text Message — Composition Error]\nTell ${displayName} you had trouble with that and ask them to try again.`;
        }
      } else {
        const body = sanitizeSmsBody(message);

        setPendingText(sessionUserName, {
          ...pendingText,
          phase: "awaiting_confirmation",
          composedBody: body,
        });

        hardcodedResponse =
          `Here's what I've got for ${pendingText.recipientName}:\n\n"${body}"\n\n` +
          `Does that look right? Say yes and I'll hand it off to your Messages app. ` +
          `Or tell me if you'd like a different tone — warmer, more casual, more professional, etc.`;

        log.info({ recipient: pendingText.recipientName, body: body.slice(0, 80) }, "[T006] Intent received — using verbatim (no tone requested)");
      }
    } else if (pendingText.phase === "awaiting_confirmation") {
      if (toneOverride !== null) {
        const effectiveTone = toneOverride;
        try {
          const recomposed = await composeTextMessage({
            recipientName: pendingText.recipientName,
            relationship: pendingText.relationship,
            tone: effectiveTone,
            userIntent: pendingText.composedBody ?? message,
            senderName: displayName,
          });

          setPendingText(sessionUserName, {
            ...pendingText,
            tone: effectiveTone,
            composedBody: recomposed.body,
          });

          const toneNote = toneLabel(effectiveTone);
          contextBlock +=
            `\n\n[Text Message Revised — ${toneNote} tone]\n` +
            `Message body:\n"${recomposed.body}"\n\n` +
            `Read the revised message back word for word, then ask: ` +
            `"Does that work? Say yes and I'll hand it off to your Messages app." ` +
            `CRITICAL HONESTY RULES: ` +
            `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
            `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
            `(3) Never say "sending now", "opening Messages", or imply immediate action.`;
        } catch (err) {
          log.warn({ err }, "[T006] Tone re-compose failed");
        }
      } else {
        const confirmIntent = await classifyConfirmationIntent(message);
        if (confirmIntent === "send") {
          const phone = pendingText.recipientPhone ?? "";
          const body = pendingText.composedBody ?? "";
          const recipientName = pendingText.recipientName;
          setPendingText(sessionUserName, null);

          const cleanPhone = phone ? sanitizePhone(phone) : "";

          // TODO: When iOS is added, send platform: 'ios'|'android' in request body and use that instead
          const bodySep = "?";
          const encodedBody = encodeURIComponent(body);
          const smsUri = cleanPhone
            ? `sms:${cleanPhone}${bodySep}body=${encodedBody}`
            : `sms:?body=${encodedBody}`;

          const payload: SmsPayload = {
            phone: cleanPhone,
            body,
            recipient: recipientName,
            smsUri,
            relationship: pendingText.relationship,
            tone: pendingText.tone,
          };
          smsPayload = payload;
          setLastSmsPayload(sessionUserName, payload);
          broadcastToUser(sessionUserName, "sms-compose", { type: "sms_compose", ...payload });

          const confirmationText = phone
            ? `The message is composed and ready. Your Messages app should open now with it pre-filled for ${recipientName} — tap Send when you're ready. I can't send it directly; that part is yours.`
            : `The message is composed and ready. Your Messages app should open now — add ${recipientName}'s number and tap Send. I can't send it directly; that part is yours.`;
          hardcodedResponse = confirmationText;

          log.info({ recipient: recipientName, hasPhone: !!phone }, "[T006] SMS packaged — hardcoded response, skipping Claude");
        } else if (confirmIntent === "cancel") {
          setPendingText(sessionUserName, null);
          contextBlock +=
            `\n\n[Text Message Cancelled]\nThe user decided not to send the message. ` +
            `Acknowledge warmly and briefly — "No problem, I've dropped it."`;
        } else {
          try {
            const revised = await composeTextMessage({
              recipientName: pendingText.recipientName,
              relationship: pendingText.relationship,
              tone: pendingText.tone,
              userIntent: `Previous draft: "${pendingText.composedBody}". User's feedback/edit: "${message}"`,
              senderName: displayName,
            });

            setPendingText(sessionUserName, {
              ...pendingText,
              composedBody: revised.body,
            });

            contextBlock +=
              `\n\n[Text Message Revised]\n` +
              `Message body:\n"${revised.body}"\n\n` +
              `Read the revised message back word for word, then ask: ` +
              `"Does that work? Say yes and I'll hand it off to your Messages app." ` +
              `CRITICAL HONESTY RULES: ` +
              `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
              `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
              `(3) Never say "sending now", "opening Messages", or imply immediate action.`;
          } catch (err) {
            log.warn({ err }, "[T006] Revision failed");
          }
        }
      }
    }
  }

  // ── T006-retry: user says "it didn't open" / "try again" after SMS dispatch ──
  if (isSmsRetryRequest && lastSmsPayload) {
    smsPayload = lastSmsPayload;
    const retryText = lastSmsPayload.phone
      ? `Trying again — your Messages app should open now with the text ready for ${lastSmsPayload.recipient}. Tap Send when it opens. I can't send it directly; that part is yours.`
      : `Trying again — your Messages app should open now with the text ready. Add ${lastSmsPayload.recipient}'s number and tap Send. I can't send it directly; that part is yours.`;
    hardcodedResponse = retryText;
    broadcastToUser(sessionUserName, "sms-compose", { type: "sms_compose", ...lastSmsPayload });
    log.info({ recipient: lastSmsPayload.recipient }, "[T006-retry] Re-firing last SMS payload");
  }

  // ── T006-edit-after-send: user wants to edit the message after it was dispatched ──
  if (isSmsEditAfterSend && lastSmsPayload) {
    const displayName = userProfile?.name ?? sessionUserName;
    setPendingText(sessionUserName, {
      phase: "awaiting_confirmation",
      recipientName: lastSmsPayload.recipient,
      recipientPhone: lastSmsPayload.phone || null,
      relationship: lastSmsPayload.relationship,
      tone: lastSmsPayload.tone ?? "casual",
      composedBody: lastSmsPayload.body,
    });

    const displayTone = lastSmsPayload.tone ?? "casual";
    try {
      const revised = await composeTextMessage({
        recipientName: lastSmsPayload.recipient,
        relationship: lastSmsPayload.relationship,
        tone: displayTone,
        userIntent: `Previous draft: "${lastSmsPayload.body}". User's edit request: "${message}"`,
        senderName: displayName,
      });

      setPendingText(sessionUserName, {
        phase: "awaiting_confirmation",
        recipientName: lastSmsPayload.recipient,
        recipientPhone: lastSmsPayload.phone || null,
        relationship: lastSmsPayload.relationship,
        tone: displayTone,
        composedBody: revised.body,
      });

      contextBlock +=
        `\n\n[Text Message Revised — edit after send]\n` +
        `Previous draft was already handed off to Messages app. User asked to edit it.\n` +
        `Revised message body:\n"${revised.body}"\n\n` +
        `Read the revised message back word for word, then ask: ` +
        `"Does that work? Say yes and I'll hand it off to your Messages app again." ` +
        `CRITICAL HONESTY RULES: ` +
        `(1) You are composing — you are NOT sending it and you CANNOT send it. ` +
        `(2) The Messages app only opens AFTER the user says yes. Do NOT say it is opening now. ` +
        `(3) Never say "sending now", "opening Messages", or imply immediate action.`;

      log.info({ recipient: lastSmsPayload.recipient }, "[T006-edit-after-send] Revised draft, restarted flow");
    } catch (err) {
      log.warn({ err }, "[T006-edit-after-send] Revision failed");
      setPendingText(sessionUserName, null);
      contextBlock +=
        `\n\n[Text Message Edit Failed]\n` +
        `Tell ${displayName} honestly: "I had trouble revising that. Just say 'text ${lastSmsPayload.recipient}' and I'll start fresh."`;
    }
  }

  return { contextBlock, hardcodedResponse, smsPayload };
}

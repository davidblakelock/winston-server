import { logger } from "../lib/logger.js";
import { getOrdersForBriefing } from "../orders/ordersManager.js";
import { getTodayTravelSegments } from "../travel/travelManager.js";
import { getBillAnomalies, type BillAnomaly } from "../bills/billAnomalyScanner.js";
import { getWeatherSuggestions, type WeatherSuggestion } from "../weather/weatherSuggestions.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import type { CalendarEvent } from "../google/calendar.js";
import type { DetectedMeetingRequest } from "../email/emailMeetingManager.js";
import { scanEmailsForDrafts, type EmailDraft } from "../email/draftScanner.js";
import { runCrossDomainEngine } from "../intelligence/crossDomainEngine.js";
import { getProactiveMode } from "../proactiveMode/proactiveModeManager.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type MorningActionType =
  | "meeting_request"
  | "order_delivery"
  | "travel_today"
  | "weather_suggestion"
  | "bill_anomaly"
  | "email_draft"
  | "cross_domain_insight";

export interface MorningAction {
  type: MorningActionType;
  title: string;
  detail: string;
  severity?: "info" | "warning" | "alert";
  data?: Record<string, unknown>;
}

// ── Converters ────────────────────────────────────────────────────────────────

function meetingRequestsToActions(meetings: DetectedMeetingRequest[]): MorningAction[] {
  return meetings.map((m) => ({
    type: "meeting_request" as MorningActionType,
    title: `Meeting Request: ${m.from}`,
    detail: m.proposedDateTimeStr
      ? `"${m.subject}" — proposed ${m.proposedDateTimeStr}${m.calendarStatus === "conflict" ? ` (conflicts with ${m.conflictEvent})` : ""}`
      : `"${m.subject}" — open scheduling request`,
    severity: m.calendarStatus === "conflict" ? ("warning" as const) : ("info" as const),
    data: {
      gmailId: m.gmailId,
      gmailThreadId: m.gmailThreadId,
      from: m.from,
      fromEmail: m.fromEmail,
      subject: m.subject,
      proposedDateTimeStr: m.proposedDateTimeStr,
      calendarStatus: m.calendarStatus,
      conflictEvent: m.conflictEvent,
      suggestedAlternative: m.suggestedAlternative,
    },
  }));
}

function ordersToActions(orders: Awaited<ReturnType<typeof getOrdersForBriefing>>): MorningAction[] {
  return orders.map((o) => ({
    type: "order_delivery" as MorningActionType,
    title: `Delivery: ${o.retailer}`,
    detail: o.expected_date
      ? `${o.item_name ?? o.retailer} — expected ${o.expected_date}`
      : `${o.item_name ?? o.retailer}`,
    severity: "info" as const,
    data: {
      id: o.id,
      retailer: o.retailer,
      status: o.status,
      expectedDate: o.expected_date,
      trackingNumber: o.tracking_number,
      orderUrl: o.order_url,
    },
  }));
}

function travelToActions(
  segments: Awaited<ReturnType<typeof getTodayTravelSegments>>,
): MorningAction[] {
  return segments.map((s) => {
    const segType = s.segment_type;
    const carrier = s.airline ?? s.car_rental_company ?? s.hotel_name ?? segType;
    const destination = s.arrival_airport ?? s.hotel_address ?? s.dropoff_location ?? null;
    const depTime = s.departure_time ?? s.pickup_datetime ?? s.checkin_date ?? null;
    const depLabel = depTime
      ? new Date(depTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })
      : null;

    return {
      type: "travel_today" as MorningActionType,
      title: `Travel Today: ${segType.charAt(0).toUpperCase() + segType.slice(1).replace(/_/g, " ")}`,
      detail: destination
        ? `${carrier} to ${destination}${depLabel ? ` at ${depLabel}` : ""}`
        : `${carrier}${depLabel ? ` at ${depLabel}` : ""}`,
      severity: "info" as const,
      data: {
        id: s.id,
        segmentType: s.segment_type,
        airline: s.airline,
        flightNumber: s.flight_number,
        departureAirport: s.departure_airport,
        arrivalAirport: s.arrival_airport,
        departureTime: s.departure_time,
        arrivalTime: s.arrival_time,
        confirmationNumber: s.confirmation_number,
      },
    };
  });
}

function weatherSuggestionsToActions(suggestions: WeatherSuggestion[]): MorningAction[] {
  return suggestions.map((s) => ({
    type: "weather_suggestion" as MorningActionType,
    title: s.title,
    detail: s.message,
    severity: s.severity,
    data: {
      suggestionType: s.type,
      eventTitle: s.eventTitle,
    },
  }));
}

function billAnomaliesToActions(anomalies: BillAnomaly[]): MorningAction[] {
  return anomalies.map((a) => ({
    type: "bill_anomaly" as MorningActionType,
    title: `Unusual Charge: ${a.retailer}`,
    detail: `$${a.currentAmount.toFixed(2)} (up ${a.percentChange.toFixed(0)}% from usual $${a.previousAmount.toFixed(2)})`,
    severity: "warning" as const,
    data: {
      retailer: a.retailer,
      currentAmount: a.currentAmount,
      previousAmount: a.previousAmount,
      percentChange: a.percentChange,
      billingDate: a.billingDate,
      emailSubject: a.emailSubject,
      emailId: a.emailId,
    },
  }));
}

function emailDraftsToActions(drafts: EmailDraft[]): MorningAction[] {
  return drafts.map((d) => ({
    type: "email_draft" as MorningActionType,
    title: `Reply Needed: ${d.sender}`,
    detail: d.originalSummary,
    severity: "info" as const,
    data: {
      emailId: d.emailId,
      sender: d.sender,
      senderEmail: d.senderEmail,
      subject: d.subject,
      emailDate: d.emailDate,
      suggestedReply: d.suggestedReply,
    },
  }));
}

// ── Main assembler ────────────────────────────────────────────────────────────

export interface AssembleMorningActionsInput {
  userName: string;
  detectedMeetings: DetectedMeetingRequest[];
  calendarEvents: CalendarEvent[];
  userCity?: string;
  userLat?: number;
  userLon?: number;
  proactiveMode?: string;
}

/**
 * Assemble all morning action cards in parallel.
 * Called at briefing delivery time after live email + calendar are already fetched.
 * Returns a flat MorningAction[] sorted by severity (alert > warning > info).
 */
export async function assembleMorningActions(
  input: AssembleMorningActionsInput,
): Promise<MorningAction[]> {
  const { userName, detectedMeetings, calendarEvents, userCity, userLat, userLon } = input;

  // Fetch proactive mode (needed for cross-domain engine)
  const mode = await getProactiveMode(userName).catch(() => "supervised" as const);

  // Run all data fetches in parallel — failures are non-fatal
  const [orders, travelSegments, billAnomalies, weatherData, crossDomainActions, emailDrafts] = await Promise.allSettled([
    getOrdersForBriefing(userName),
    getTodayTravelSegments(userName),
    getBillAnomalies(userName),
    userLat && userLon && userCity
      ? getCachedWeather(userCity, userLat, userLon)
      : Promise.resolve(null),
    mode !== "briefing_only"
      ? runCrossDomainEngine({
          userName,
          calendarEvents,
          mode,
          userCity,
          userLat,
          userLon,
        })
      : Promise.resolve([]),
    // Scan for emails needing a reply — capped at 5 emails, 8-second hard timeout
    // to prevent sequential Claude calls from blocking the morning response.
    Promise.race([
      scanEmailsForDrafts(userName, 5),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("email draft scan timeout")), 8000)),
    ]),
  ]);

  const allActions: MorningAction[] = [];

  // Meeting requests (already computed, no extra fetch needed)
  if (detectedMeetings.length > 0) {
    allActions.push(...meetingRequestsToActions(detectedMeetings));
  }

  // Orders / deliveries
  if (orders.status === "fulfilled" && orders.value.length > 0) {
    allActions.push(...ordersToActions(orders.value));
  } else if (orders.status === "rejected") {
    logger.warn({ err: orders.reason, userName }, "[MorningActions] Orders fetch failed");
  }

  // Travel today
  if (travelSegments.status === "fulfilled" && travelSegments.value.length > 0) {
    allActions.push(...travelToActions(travelSegments.value));
  } else if (travelSegments.status === "rejected") {
    logger.warn({ err: travelSegments.reason, userName }, "[MorningActions] Travel fetch failed");
  }

  // Bill anomalies
  if (billAnomalies.status === "fulfilled" && billAnomalies.value.length > 0) {
    allActions.push(...billAnomaliesToActions(billAnomalies.value));
  } else if (billAnomalies.status === "rejected") {
    logger.warn({ err: billAnomalies.reason, userName }, "[MorningActions] Bill anomalies fetch failed");
  }

  // Weather suggestions (requires weather + calendar)
  if (weatherData.status === "fulfilled" && weatherData.value) {
    const suggestions = getWeatherSuggestions(weatherData.value, calendarEvents);
    if (suggestions.length > 0) {
      allActions.push(...weatherSuggestionsToActions(suggestions));
    }
  } else if (weatherData.status === "rejected") {
    logger.warn({ err: weatherData.reason, userName }, "[MorningActions] Weather fetch failed");
  }

  // Cross-domain intelligence (calendar-dependent checks run here with live events)
  if (crossDomainActions.status === "fulfilled" && crossDomainActions.value.length > 0) {
    allActions.push(...crossDomainActions.value);
  } else if (crossDomainActions.status === "rejected") {
    logger.warn({ err: crossDomainActions.reason, userName }, "[MorningActions] Cross-domain engine failed");
  }

  // Pending email drafts (emails that need a reply)
  if (emailDrafts.status === "fulfilled" && emailDrafts.value.length > 0) {
    allActions.push(...emailDraftsToActions(emailDrafts.value));
  } else if (emailDrafts.status === "rejected") {
    logger.warn({ err: emailDrafts.reason, userName }, "[MorningActions] Email drafts fetch failed");
  }

  // Sort: alert > warning > info
  const severityOrder = { alert: 0, warning: 1, info: 2, undefined: 3 };
  allActions.sort(
    (a, b) =>
      (severityOrder[a.severity ?? "undefined"] ?? 3) -
      (severityOrder[b.severity ?? "undefined"] ?? 3)
  );

  logger.info(
    { userName, count: allActions.length },
    "[MorningActions] Actions assembled"
  );

  return allActions;
}

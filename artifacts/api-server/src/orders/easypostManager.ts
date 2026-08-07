import EasyPost from "@easypost/api";
import { logger } from "../lib/logger.js";
import type { OrderStatus } from "./ordersManager.js";

const apiKey = process.env.EASYPOST_API_KEY ?? "";
const client = new EasyPost(apiKey);

export interface TrackingEvent {
  status: string;
  message: string;
  datetime: string;
  location: string | null;
}

export interface EasyPostTrackerResult {
  trackerId: string;
  status: string;
  carrier: string;
  publicUrl: string;
  estDeliveryDate: string | null;
  trackingEvents: TrackingEvent[];
}

function mapTrackingDetails(details: { status: string; message: string; datetime: string; tracking_location?: { city?: string; state?: string } }[] | undefined): TrackingEvent[] {
  return (details ?? []).map((d) => ({
    status: d.status,
    message: d.message,
    datetime: d.datetime,
    location: d.tracking_location?.city
      ? `${d.tracking_location.city}, ${d.tracking_location.state ?? ""}`.trim().replace(/,$/, "")
      : null,
  }));
}

export async function createTracker(
  trackingNumber: string,
  carrier?: string
): Promise<EasyPostTrackerResult | null> {
  try {
    const tracker = await client.Tracker.create({
      tracking_code: trackingNumber,
      ...(carrier ? { carrier } : {}),
    });

    return {
      trackerId: tracker.id,
      status: tracker.status,
      carrier: tracker.carrier,
      publicUrl: tracker.public_url,
      estDeliveryDate: tracker.est_delivery_date ?? null,
      trackingEvents: mapTrackingDetails(tracker.tracking_details),
    };
  } catch (err) {
    logger.warn({ err, trackingNumber }, "[EasyPost] Failed to create tracker");
    return null;
  }
}

// Backstop for when the webhook never arrives (misconfigured/stale account
// webhook URL, a dropped delivery, etc.) — a poller calls this directly
// instead of waiting on EasyPost to tell us.
export async function getTracker(trackerId: string): Promise<EasyPostTrackerResult | null> {
  try {
    const tracker = await client.Tracker.retrieve(trackerId);
    return {
      trackerId: tracker.id,
      status: tracker.status,
      carrier: tracker.carrier,
      publicUrl: tracker.public_url,
      estDeliveryDate: tracker.est_delivery_date ?? null,
      trackingEvents: mapTrackingDetails(tracker.tracking_details),
    };
  } catch (err) {
    logger.warn({ err, trackerId }, "[EasyPost] Failed to retrieve tracker");
    return null;
  }
}

export function parseWebhookEvent(payload: any): {
  trackerId: string;
  status: string;
  carrier: string;
  estDeliveryDate: string | null;
  trackingEvents: TrackingEvent[];
  publicUrl: string;
} | null {
  try {
    if (payload?.description !== "tracker.updated") return null;
    const tracker = payload.result;
    if (!tracker?.id) return null;

    return {
      trackerId: tracker.id,
      status: tracker.status,
      carrier: tracker.carrier,
      estDeliveryDate: tracker.est_delivery_date ?? null,
      publicUrl: tracker.public_url ?? "",
      trackingEvents: mapTrackingDetails(tracker.tracking_details),
    };
  } catch (err) {
    logger.warn({ err }, "[EasyPost] Failed to parse webhook event");
    return null;
  }
}

// Confirmed live: this EasyPost account had ZERO registered webhooks —
// routes/easypost.ts (the receiving endpoint) was correct and reachable the
// whole time, but EasyPost had never been told to call it, so every tracker
// update relied entirely on the 4h polling backstop. Two real orders sat
// showing "out for delivery" over an hour after EasyPost's own data already
// said "delivered." Registering a webhook is a one-time account-level
// action that doesn't need repeating on every deploy, but checking (and
// re-registering if missing) on startup means this can't silently regress
// again — e.g. an account reset or key rotation — without anyone noticing
// until a poller cycle eventually papers over it.
const WEBHOOK_URL = "https://workspaceapi-server-production-5fd6.up.railway.app/api/easypost/webhook";

export async function ensureEasyPostWebhook(): Promise<void> {
  if (!apiKey) return;
  try {
    const existing = await client.Webhook.all();
    const hasOurs = (existing.webhooks ?? []).some(
      (w: { url?: string; disabled_at?: string | null }) => w.url === WEBHOOK_URL && !w.disabled_at
    );
    if (hasOurs) {
      logger.info("[EasyPost] Webhook already registered");
      return;
    }
    await client.Webhook.create({ url: WEBHOOK_URL });
    logger.info({ url: WEBHOOK_URL }, "[EasyPost] Webhook registered");
  } catch (err) {
    logger.warn({ err }, "[EasyPost] ensureEasyPostWebhook failed — tracking will fall back to the 4h poller");
  }
}

export function isKeyTrackingStatus(status: string): boolean {
  return ["out_for_delivery", "delivered", "available_for_pickup", "return_to_sender", "failure"].includes(status);
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    unknown: "Label Created",
    pre_transit: "Pre-Transit",
    in_transit: "In Transit",
    out_for_delivery: "Out for Delivery",
    delivered: "Delivered",
    available_for_pickup: "Available for Pickup",
    return_to_sender: "Returned to Sender",
    failure: "Delivery Failed",
    cancelled: "Cancelled",
    error: "Error",
  };
  return labels[status] ?? status;
}

// EasyPost's raw tracker.status vocabulary doesn't line up 1:1 with our
// OrderStatus column — four values match exactly, the rest need mapping onto
// the closest existing bucket. This is what the `status` column must always
// be written from (getStatusLabel's human-readable string belongs in
// status_detail only — writing it into `status` breaks every comparison
// this app makes against that column, including sort order and forward-
// progress checks in ordersManager.ts).
export function mapEasyPostStatus(status: string): OrderStatus {
  switch (status) {
    case "pre_transit":
    case "in_transit":
    case "out_for_delivery":
    case "delivered":
      return status;
    case "available_for_pickup":
      return "out_for_delivery"; // closest existing "almost there" bucket
    case "return_to_sender":
    case "failure":
    case "cancelled":
    case "error":
      return "exception";
    case "unknown":
    default:
      return "pre_transit"; // no info yet — earliest known state
  }
}

import EasyPost from "@easypost/api";
import { logger } from "../lib/logger.js";

const apiKey =
  process.env.EASYPOST_API_KEY_TEST ??
  process.env.EASYPOST_API_KEY_PRODUCTION ??
  process.env.EASYPOST_API_KEY ??
  "";
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

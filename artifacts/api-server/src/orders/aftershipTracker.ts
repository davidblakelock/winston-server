import { logger } from "../lib/logger.js";
import type { OrderStatus, TrackingEvent } from "./ordersManager.js";

const AFTERSHIP_API_KEY = process.env.AFTERSHIP_API_KEY ?? "";
const AFTERSHIP_BASE = "https://api.aftership.com/v4";

export interface TrackingResult {
  status: OrderStatus;
  carrier: string | null;
  aftership_slug: string | null;
  expected_date: string | null;
  events: TrackingEvent[];
}

// ── AfterShip status → our status ────────────────────────────────────────────

function mapAfterShipStatus(tag: string): OrderStatus {
  switch (tag) {
    case "Delivered":       return "delivered";
    case "OutForDelivery":  return "out_for_delivery";
    case "AttemptFail":
    case "Exception":
    case "Expired":         return "exception";
    case "InTransit":       return "in_transit";
    case "InfoReceived":    return "shipped";
    case "Pending":
    default:                return "shipped";
  }
}

// ── Carrier slug guesses from tracking number format ─────────────────────────

function guessSlug(trackingNumber: string, carrierHint?: string | null): string | null {
  if (carrierHint) {
    const c = carrierHint.toLowerCase();
    if (c.includes("ups"))   return "ups";
    if (c.includes("fedex")) return "fedex";
    if (c.includes("usps"))  return "usps";
    if (c.includes("dhl"))   return "dhl";
  }
  const tn = trackingNumber.toUpperCase();
  if (/^1Z[A-Z0-9]{16}$/.test(tn)) return "ups";
  if (/^(94|93|92|91|95)\d{20,}$/.test(tn)) return "usps";
  if (/^\d{12,22}$/.test(tn)) return "fedex";
  if (/^J[A-Z0-9]{11,25}$/.test(tn)) return "dhl";
  return null;
}

// ── Create tracking ───────────────────────────────────────────────────────────

async function createTracking(
  trackingNumber: string,
  slug?: string | null
): Promise<{ slug: string } | null> {
  const body: Record<string, unknown> = {
    tracking: { tracking_number: trackingNumber },
  };
  if (slug) body.tracking = { ...body.tracking as object, slug };

  try {
    const res = await fetch(`${AFTERSHIP_BASE}/trackings`, {
      method: "POST",
      headers: {
        "as-api-key": AFTERSHIP_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await res.json()) as {
      meta: { code: number; message: string };
      data?: { tracking?: { slug?: string } };
    };

    if (res.status === 409) {
      // Already registered — slug might be in error message or we need to detect
      logger.info({ trackingNumber }, "[AfterShip] Tracking already exists");
      return { slug: slug ?? "unknown" };
    }

    if (!res.ok) {
      logger.warn(
        { status: res.status, msg: data.meta?.message, trackingNumber },
        "[AfterShip] Create tracking failed"
      );
      return null;
    }

    const returnedSlug = data.data?.tracking?.slug;
    return returnedSlug ? { slug: returnedSlug } : null;
  } catch (err) {
    logger.warn({ err, trackingNumber }, "[AfterShip] Create tracking error");
    return null;
  }
}

// ── Get tracking status ───────────────────────────────────────────────────────

async function getTrackingBySlug(
  slug: string,
  trackingNumber: string
): Promise<TrackingResult | null> {
  try {
    const res = await fetch(
      `${AFTERSHIP_BASE}/trackings/${encodeURIComponent(slug)}/${encodeURIComponent(trackingNumber)}`,
      {
        headers: { "as-api-key": AFTERSHIP_API_KEY },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      logger.warn({ status: res.status, slug, trackingNumber }, "[AfterShip] Get tracking failed");
      return null;
    }

    const data = (await res.json()) as {
      data?: {
        tracking?: {
          tag?: string;
          slug?: string;
          active?: boolean;
          expected_delivery?: string | null;
          shipment_delivery_date?: string | null;
          checkpoints?: Array<{
            checkpoint_time?: string;
            message?: string;
            city?: string;
            state?: string;
            country_name?: string;
            tag?: string;
          }>;
        };
      };
    };

    const tracking = data.data?.tracking;
    if (!tracking) return null;

    const tag = tracking.tag ?? "Pending";
    const status = mapAfterShipStatus(tag);

    const rawDate = tracking.expected_delivery ?? tracking.shipment_delivery_date ?? null;
    const expectedDate = rawDate ? rawDate.split("T")[0] : null;

    const events: TrackingEvent[] = (tracking.checkpoints ?? [])
      .map((cp) => ({
        timestamp: cp.checkpoint_time ?? "",
        message: cp.message ?? "",
        location: [cp.city, cp.state, cp.country_name].filter(Boolean).join(", ") || null,
        status: cp.tag ?? null,
      }))
      .reverse(); // most recent first

    const slugFromData = tracking.slug ?? slug;
    const carrierFromSlug = slugToCarrierName(slugFromData);

    return {
      status,
      carrier: carrierFromSlug,
      aftership_slug: slugFromData,
      expected_date: expectedDate,
      events,
    };
  } catch (err) {
    logger.warn({ err, slug, trackingNumber }, "[AfterShip] Get tracking error");
    return null;
  }
}

function slugToCarrierName(slug: string): string {
  const map: Record<string, string> = {
    ups: "UPS",
    fedex: "FedEx",
    usps: "USPS",
    dhl: "DHL",
    "dhl-global-mail": "DHL",
    "amazon-logistics": "Amazon",
    ontrac: "OnTrac",
    lasership: "LaserShip",
  };
  return map[slug] ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isAfterShipEnabled(): boolean {
  return Boolean(AFTERSHIP_API_KEY);
}

export async function trackOrder(
  trackingNumber: string,
  existingSlug?: string | null,
  carrierHint?: string | null
): Promise<TrackingResult | null> {
  if (!AFTERSHIP_API_KEY) {
    logger.warn("[AfterShip] AFTERSHIP_API_KEY not set — skipping live tracking");
    return null;
  }

  let slug = existingSlug ?? guessSlug(trackingNumber, carrierHint);

  // If we don't have a slug, create the tracking first to get it
  if (!slug) {
    const created = await createTracking(trackingNumber, null);
    if (!created) return null;
    slug = created.slug;
  }

  if (!slug || slug === "unknown") {
    // Try to create with slug guessing
    const created = await createTracking(trackingNumber, null);
    slug = created?.slug ?? null;
  }

  if (!slug) return null;

  // Ensure tracking exists before fetching (idempotent)
  await createTracking(trackingNumber, slug).catch(() => {});

  return getTrackingBySlug(slug, trackingNumber);
}

// ── Carrier tracking URLs ─────────────────────────────────────────────────────

export function buildCarrierUrl(trackingNumber: string, carrier?: string | null, slug?: string | null): string | null {
  const key = (slug ?? carrier ?? "").toLowerCase();
  const tn = encodeURIComponent(trackingNumber);
  if (key.includes("ups"))   return `https://www.ups.com/track?tracknum=${tn}`;
  if (key.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
  if (key.includes("usps"))  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
  if (key.includes("dhl"))   return `https://www.dhl.com/en/express/tracking.html?AWB=${tn}`;
  if (key.includes("amazon")) return `https://www.amazon.com/progress-tracker/package/?_encoding=UTF8&itemId=`;
  return null;
}

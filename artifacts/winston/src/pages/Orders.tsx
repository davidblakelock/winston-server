import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  RefreshCw,
  Package,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Truck,
  CheckCircle2,
  AlertCircle,
  Clock,
  MapPin,
  Trash2,
} from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type OrderStatus =
  | "ordered"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception";

interface TrackingEvent {
  timestamp: string;
  message: string;
  location?: string | null;
  status?: string | null;
}

interface Order {
  id: number;
  retailer: string;
  item_name: string;
  order_number: string | null;
  tracking_number: string | null;
  carrier: string | null;
  aftership_slug: string | null;
  status: OrderStatus;
  expected_date: string | null;
  order_total: string | null;
  order_url: string | null;
  tracking_events: TrackingEvent[];
  last_tracked_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; color: string; icon: React.ReactNode; border: string }
> = {
  ordered: {
    label: "Ordered",
    color: "rgba(156,163,175,0.9)",
    icon: <Clock className="h-3.5 w-3.5" />,
    border: "rgba(156,163,175,0.3)",
  },
  shipped: {
    label: "Shipped",
    color: "rgba(96,165,250,0.9)",
    icon: <Package className="h-3.5 w-3.5" />,
    border: "rgba(96,165,250,0.3)",
  },
  in_transit: {
    label: "In Transit",
    color: "rgba(167,139,250,0.9)",
    icon: <Truck className="h-3.5 w-3.5" />,
    border: "rgba(167,139,250,0.3)",
  },
  out_for_delivery: {
    label: "Out for Delivery",
    color: "rgba(251,191,36,0.95)",
    icon: <Truck className="h-3.5 w-3.5" />,
    border: "rgba(251,191,36,0.4)",
  },
  delivered: {
    label: "Delivered",
    color: "rgba(52,211,153,0.9)",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    border: "rgba(52,211,153,0.3)",
  },
  exception: {
    label: "Exception",
    color: "rgba(248,113,113,0.9)",
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    border: "rgba(248,113,113,0.4)",
  },
};

function getCardAccentColor(order: Order): string {
  if (order.status === "exception") return "rgba(248,113,113,0.7)";
  if (order.status === "out_for_delivery") return "rgba(251,191,36,0.8)";
  if (order.status === "delivered") return "rgba(52,211,153,0.5)";
  if (!order.expected_date) return "rgba(96,165,250,0.4)";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expected = new Date(order.expected_date + "T00:00:00");
  const diffDays = Math.floor((expected.getTime() - today.getTime()) / 86400000);
  if (diffDays < -1) return "rgba(248,113,113,0.5)"; // overdue
  if (diffDays < 0) return "rgba(251,191,36,0.5)";   // yesterday
  return "rgba(52,211,153,0.4)";                      // on track
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.getTime() === today.getTime()) return "Today";
  if (d.getTime() === tomorrow.getTime()) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatEventTime(ts: string): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return ts;
  }
}

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return dateStr === today;
}

function buildCarrierUrl(trackingNumber: string, carrier?: string | null, slug?: string | null): string | null {
  const key = (slug ?? carrier ?? "").toLowerCase();
  const tn = encodeURIComponent(trackingNumber);
  if (key.includes("ups"))    return `https://www.ups.com/track?tracknum=${tn}`;
  if (key.includes("fedex"))  return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
  if (key.includes("usps"))   return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
  if (key.includes("dhl"))    return `https://www.dhl.com/en/express/tracking.html?AWB=${tn}`;
  return null;
}

function OrderCard({ order, token, onDelete }: {
  order: Order;
  token: string;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const cfg = STATUS_CONFIG[order.status];
  const accent = getCardAccentColor(order);
  const carrierUrl = order.tracking_number
    ? buildCarrierUrl(order.tracking_number, order.carrier, order.aftership_slug)
    : null;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Remove "${order.item_name}"?`)) return;
    setDeleting(true);
    try {
      await fetch(`${API}/api/orders/${order.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      onDelete(order.id);
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        border: `1px solid rgba(255,255,255,0.09)`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: "10px",
        overflow: "hidden",
        transition: "border-color 0.2s",
      }}
    >
      {/* Card header — tap to expand */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left"
        style={{ padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: "12px" }}
      >
        {/* Status dot */}
        <div style={{ marginTop: "3px", flexShrink: 0 }}>
          <div style={{ color: cfg.color }}>{cfg.icon}</div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Retailer + delete */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "2px" }}>
            <span style={{ fontSize: "0.7rem", color: "rgba(156,163,175,0.8)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {order.retailer}
            </span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{ color: "rgba(156,163,175,0.4)", padding: "2px", marginLeft: "8px" }}
              className="hover:text-red-400 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Item name */}
          <p style={{ fontSize: "0.9rem", color: "rgba(255,255,255,0.9)", lineHeight: 1.3, marginBottom: "8px", fontWeight: 500 }}>
            {order.item_name}
          </p>

          {/* Status badge + date */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "0.7rem",
                fontWeight: 600,
                color: cfg.color,
                background: `${cfg.color}18`,
                border: `1px solid ${cfg.border}`,
                borderRadius: "20px",
                padding: "2px 8px",
              }}
            >
              {cfg.icon}
              {cfg.label}
            </span>

            {order.expected_date && (
              <span style={{ fontSize: "0.75rem", color: "rgba(156,163,175,0.7)" }}>
                {order.status === "delivered" ? "Delivered" : "Arrives"} {formatDate(order.expected_date)}
              </span>
            )}

            {order.carrier && (
              <span style={{ fontSize: "0.7rem", color: "rgba(156,163,175,0.5)" }}>
                via {order.carrier}
              </span>
            )}

            {order.order_total && (
              <span style={{ fontSize: "0.7rem", color: "rgba(156,163,175,0.5)" }}>
                {order.order_total}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div style={{ flexShrink: 0, color: "rgba(156,163,175,0.4)", marginTop: "2px" }}>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {/* Expanded: timeline + links */}
      {expanded && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "14px 16px" }}>
          {/* Links row */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
            {carrierUrl && (
              <a
                href={carrierUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "0.75rem",
                  color: "rgba(96,165,250,0.9)",
                  background: "rgba(96,165,250,0.08)",
                  border: "1px solid rgba(96,165,250,0.2)",
                  borderRadius: "6px",
                  padding: "5px 10px",
                  textDecoration: "none",
                }}
              >
                <Truck className="h-3 w-3" />
                Track with {order.carrier ?? "carrier"}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {order.order_url && (
              <a
                href={order.order_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "0.75rem",
                  color: "rgba(167,139,250,0.9)",
                  background: "rgba(167,139,250,0.08)",
                  border: "1px solid rgba(167,139,250,0.2)",
                  borderRadius: "6px",
                  padding: "5px 10px",
                  textDecoration: "none",
                }}
              >
                <Package className="h-3 w-3" />
                View order
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {/* Order / tracking numbers */}
          <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "16px" }}>
            {order.order_number && (
              <div style={{ fontSize: "0.72rem", color: "rgba(156,163,175,0.6)" }}>
                Order #{order.order_number}
              </div>
            )}
            {order.tracking_number && (
              <div style={{ fontSize: "0.72rem", color: "rgba(156,163,175,0.6)", fontFamily: "monospace" }}>
                Tracking: {order.tracking_number}
              </div>
            )}
          </div>

          {/* Tracking timeline */}
          {order.tracking_events.length > 0 ? (
            <div>
              <p style={{ fontSize: "0.7rem", color: "rgba(156,163,175,0.5)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "10px" }}>
                Tracking Timeline
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
                {order.tracking_events.map((ev, i) => (
                  <div key={i} style={{ display: "flex", gap: "12px", position: "relative" }}>
                    {/* Timeline line */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "16px", flexShrink: 0 }}>
                      <div style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: i === 0 ? cfg.color : "rgba(75,85,99,0.8)",
                        flexShrink: 0,
                        marginTop: "4px",
                      }} />
                      {i < order.tracking_events.length - 1 && (
                        <div style={{ width: "1px", flex: 1, background: "rgba(75,85,99,0.4)", minHeight: "16px" }} />
                      )}
                    </div>

                    <div style={{ paddingBottom: i < order.tracking_events.length - 1 ? "14px" : "0", flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: "0.8rem", color: i === 0 ? "rgba(255,255,255,0.85)" : "rgba(156,163,175,0.7)", lineHeight: 1.3 }}>
                        {ev.message}
                      </p>
                      <div style={{ display: "flex", gap: "8px", marginTop: "3px", flexWrap: "wrap" }}>
                        {ev.timestamp && (
                          <span style={{ fontSize: "0.68rem", color: "rgba(107,114,128,0.8)" }}>
                            {formatEventTime(ev.timestamp)}
                          </span>
                        )}
                        {ev.location && (
                          <span style={{ fontSize: "0.68rem", color: "rgba(107,114,128,0.7)", display: "flex", alignItems: "center", gap: "2px" }}>
                            <MapPin className="h-2.5 w-2.5" />
                            {ev.location}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ fontSize: "0.75rem", color: "rgba(156,163,175,0.4)", fontStyle: "italic" }}>
              {order.tracking_number
                ? "No tracking events yet — sync to update"
                : "No tracking number available"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Orders() {
  const [, setLocation] = useLocation();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("winston_session_token") ?? "";

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { orders: Order[] };
      setOrders(data.orders ?? []);
    } catch {
      setError("Could not load orders.");
    }
  }, [token]);

  useEffect(() => { void fetchOrders(); }, [fetchOrders]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await fetch(`${API}/api/orders/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        ok: boolean;
        newOrders: number;
        trackingUpdated: number;
        orders: Order[];
      };
      setOrders(data.orders ?? []);
      setSyncMsg(
        data.newOrders > 0
          ? `Found ${data.newOrders} new order${data.newOrders !== 1 ? "s" : ""}, updated ${data.trackingUpdated} tracking${data.trackingUpdated !== 1 ? "s" : ""}`
          : `Tracking updated for ${data.trackingUpdated} order${data.trackingUpdated !== 1 ? "s" : ""} — no new emails`
      );
    } catch {
      setError("Sync failed. Please try again.");
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = (id: number) => {
    setOrders((prev) => (prev ?? []).filter((o) => o.id !== id));
  };

  // Partition orders
  const todayOrders = (orders ?? []).filter(
    (o) => o.status === "out_for_delivery" && isToday(o.expected_date)
  );
  const activeOrders = (orders ?? []).filter(
    (o) =>
      o.status !== "delivered" &&
      !(o.status === "out_for_delivery" && isToday(o.expected_date))
  );
  const deliveredOrders = (orders ?? []).filter((o) => o.status === "delivered");

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "linear-gradient(135deg, #0a0a0a 0%, #111118 50%, #0d0d14 100%)",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 16px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          position: "sticky",
          top: 0,
          background: "rgba(10,10,10,0.95)",
          backdropFilter: "blur(12px)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            onClick={() => setLocation("/")}
            style={{ color: "rgba(156,163,175,0.7)", padding: "4px" }}
            className="hover:text-white transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 style={{ fontSize: "1.1rem", fontWeight: 600, margin: 0 }}>Orders</h1>
        </div>

        <button
          onClick={handleSync}
          disabled={syncing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "0.8rem",
            color: syncing ? "rgba(156,163,175,0.5)" : "rgba(167,139,250,0.9)",
            background: "rgba(167,139,250,0.08)",
            border: "1px solid rgba(167,139,250,0.2)",
            borderRadius: "8px",
            padding: "6px 12px",
            cursor: syncing ? "not-allowed" : "pointer",
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </div>

      {/* Sync status */}
      {syncMsg && (
        <div style={{ padding: "10px 16px", background: "rgba(52,211,153,0.07)", borderBottom: "1px solid rgba(52,211,153,0.12)" }}>
          <p style={{ fontSize: "0.78rem", color: "rgba(52,211,153,0.9)", margin: 0 }}>{syncMsg}</p>
        </div>
      )}
      {error && (
        <div style={{ padding: "10px 16px", background: "rgba(248,113,113,0.07)", borderBottom: "1px solid rgba(248,113,113,0.12)" }}>
          <p style={{ fontSize: "0.78rem", color: "rgba(248,113,113,0.9)", margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Content */}
      <div style={{ padding: "16px", maxWidth: "640px", margin: "0 auto" }}>
        {orders === null ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(156,163,175,0.5)" }}>
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-3" />
            <p style={{ fontSize: "0.85rem" }}>Loading orders…</p>
          </div>
        ) : orders.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(156,163,175,0.4)" }}>
            <Package className="h-12 w-12 mx-auto mb-4 opacity-30" />
            <p style={{ fontSize: "0.95rem", marginBottom: "8px" }}>No orders yet</p>
            <p style={{ fontSize: "0.8rem" }}>Tap Sync to scan your Gmail for order confirmations and shipping notifications</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

            {/* Arriving Today */}
            {todayOrders.length > 0 && (
              <section>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <div style={{
                    width: "8px", height: "8px", borderRadius: "50%",
                    background: "rgba(251,191,36,0.9)",
                    boxShadow: "0 0 8px rgba(251,191,36,0.6)",
                  }} />
                  <h2 style={{ fontSize: "0.75rem", color: "rgba(251,191,36,0.8)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, margin: 0 }}>
                    Arriving Today
                  </h2>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {todayOrders.map((o) => (
                    <OrderCard key={o.id} order={o} token={token} onDelete={handleDelete} />
                  ))}
                </div>
              </section>
            )}

            {/* Active Orders */}
            {activeOrders.length > 0 && (
              <section>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <h2 style={{ fontSize: "0.75rem", color: "rgba(156,163,175,0.5)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, margin: 0 }}>
                    Active Orders
                  </h2>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {activeOrders.map((o) => (
                    <OrderCard key={o.id} order={o} token={token} onDelete={handleDelete} />
                  ))}
                </div>
              </section>
            )}

            {/* Recently Delivered */}
            {deliveredOrders.length > 0 && (
              <section>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <h2 style={{ fontSize: "0.75rem", color: "rgba(156,163,175,0.5)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, margin: 0 }}>
                    Recently Delivered
                  </h2>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {deliveredOrders.map((o) => (
                    <OrderCard key={o.id} order={o} token={token} onDelete={handleDelete} />
                  ))}
                </div>
                <p style={{ fontSize: "0.7rem", color: "rgba(107,114,128,0.5)", marginTop: "10px", textAlign: "center" }}>
                  Delivered orders auto-archive after 7 days
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

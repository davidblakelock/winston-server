import { query } from "../db.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { logger } from "../lib/logger.js";

export type OrderStatus =
  | "pre_transit"
  | "ordered"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delayed"
  | "exception";

export interface TrackingEvent {
  timestamp: string;
  message: string;
  location?: string | null;
  status?: string | null;
}

export interface Order {
  id: number;
  user_name: string;
  retailer: string;
  item_name: string;
  order_number: string | null;
  tracking_number: string | null;
  carrier: string | null;
  status: OrderStatus;
  status_color: string | null;
  status_detail: string | null;
  expected_date: string | null;
  order_total: string | null;
  email_id: string | null;
  order_url: string | null;
  tracking_events: TrackingEvent[];
  last_tracked_at: string | null;
  easypost_tracker_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewOrder {
  retailer: string;
  item_name: string;
  order_number?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  status?: OrderStatus;
  expected_date?: string | null;
  order_total?: string | null;
  email_id?: string | null;
  order_url?: string | null;
}

// ── Startup migration ──────────────────────────────────────────────────────────
export async function ensureOrdersTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS orders (
        id serial PRIMARY KEY,
        user_name text NOT NULL DEFAULT '${NATIVE_USER}',
        retailer text NOT NULL,
        item_name text NOT NULL,
        order_number text,
        tracking_number text,
        carrier text,
        status text NOT NULL DEFAULT 'ordered',
        expected_date date,
        order_total text,
        email_id text,
        order_url text,
        tracking_events jsonb NOT NULL DEFAULT '[]',
        last_tracked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orders_email_id_idx
      ON orders (user_name, email_id) WHERE email_id IS NOT NULL
    `).catch(() => {});
    // Prevent duplicate rows when multiple emails reference the same tracking number
    // (e.g. "order confirmed" email + "your item shipped" email for the same package).
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_number_idx
      ON orders (user_name, tracking_number) WHERE tracking_number IS NOT NULL
    `).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS order_sync_state (
        user_name text PRIMARY KEY,
        last_scan_at timestamptz
      )
    `);
    // Add direct-carrier tracking columns (idempotent)
    await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_color text`).catch(() => {});
    await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_detail text`).catch(() => {});
    await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS easypost_tracker_id text`).catch(() => {});
    logger.info("[Orders] Table and sync state ready");
  } catch (err) {
    logger.warn({ err }, "[Orders] Startup migration warning");
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export async function getOrders(userName = NATIVE_USER): Promise<Order[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await query<Order>(
    `SELECT * FROM orders
     WHERE user_name = $1
       AND (
         status != 'delivered'
         OR (status = 'delivered' AND updated_at > $2)
       )
     ORDER BY
       CASE WHEN status = 'out_for_delivery' THEN 0
            WHEN status = 'in_transit'        THEN 1
            WHEN status = 'shipped'           THEN 2
            WHEN status = 'ordered'           THEN 3
            WHEN status = 'delivered'         THEN 4
            ELSE 5 END,
       expected_date ASC NULLS LAST,
       created_at DESC`,
    [userName, sevenDaysAgo]
  );
  return rows.map((r) => ({
    ...r,
    tracking_events: (r.tracking_events as unknown as TrackingEvent[]) ?? [],
  }));
}

export async function getOrdersForBriefing(userName = NATIVE_USER): Promise<Order[]> {
  // Use UTC for order date comparison — order dates are absolute dates
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  const { rows } = await query<Order>(
    `SELECT * FROM orders
     WHERE user_name = $1
       AND status = 'out_for_delivery'
       AND (expected_date = $2 OR expected_date IS NULL)`,
    [userName, todayStr]
  );
  return rows;
}

export async function upsertOrder(
  userName: string,
  order: NewOrder
): Promise<Order | null> {
  try {
    // ── Priority 1: match by tracking_number ────────────────────────────────
    // "Order shipped" email arrives with same TN as an earlier "order confirmed"
    // email that already stored the TN — just update the existing row.
    if (order.tracking_number) {
      const { rows: byTN } = await query<Order>(
        `SELECT * FROM orders WHERE user_name = $1 AND tracking_number = $2 LIMIT 1`,
        [userName, order.tracking_number]
      );
      if (byTN.length > 0) {
        const row = byTN[0]!;
        const { rows: updated } = await query<Order>(
          `UPDATE orders SET
             retailer        = $3,
             item_name       = $4,
             order_number    = COALESCE($5, order_number),
             carrier         = COALESCE($6, carrier),
             status          = CASE WHEN $7 > status THEN $7 ELSE status END,
             expected_date   = COALESCE($8::date, expected_date),
             order_total     = COALESCE($9, order_total),
             email_id        = COALESCE(email_id, $10),
             order_url       = COALESCE($11, order_url),
             updated_at      = now()
           WHERE id = $1 AND user_name = $2
           RETURNING *`,
          [
            row.id, userName,
            order.retailer, order.item_name,
            order.order_number ?? null, order.carrier ?? null,
            order.status ?? "ordered", order.expected_date ?? null,
            order.order_total ?? null, order.email_id ?? null,
            order.order_url ?? null,
          ]
        );
        return updated[0] ?? null;
      }

      // ── Priority 2: match by order_number when we now have a tracking number ──
      // "Order confirmed" email created a row with order_number but no tracking.
      // The later "shipped" email has both — update the existing row rather than
      // creating a second row for the same physical package.
      if (order.order_number) {
        const { rows: byON } = await query<Order>(
          `SELECT * FROM orders
           WHERE user_name = $1 AND order_number = $2 AND tracking_number IS NULL
           LIMIT 1`,
          [userName, order.order_number]
        );
        if (byON.length > 0) {
          const row = byON[0]!;
          const { rows: updated } = await query<Order>(
            `UPDATE orders SET
               tracking_number = $3,
               carrier         = COALESCE($4, carrier),
               status          = CASE WHEN $5 > status THEN $5 ELSE status END,
               expected_date   = COALESCE($6::date, expected_date),
               order_total     = COALESCE($7, order_total),
               order_url       = COALESCE($8, order_url),
               updated_at      = now()
             WHERE id = $1 AND user_name = $2
             RETURNING *`,
            [
              row.id, userName,
              order.tracking_number, order.carrier ?? null,
              order.status ?? "ordered", order.expected_date ?? null,
              order.order_total ?? null, order.order_url ?? null,
            ]
          );
          logger.info(
            { orderId: row.id, orderNumber: order.order_number, trackingNumber: order.tracking_number },
            "[Orders] Merged tracking number into existing order-number row"
          );
          return updated[0] ?? null;
        }
      }
    }

    // ── Priority 3: insert fresh, dedup by email_id ──────────────────────────
    // No existing row matched — insert. ON CONFLICT on email_id handles the case
    // where we see the same email again (e.g. on a force-sync).
    const { rows } = await query<Order>(
      `INSERT INTO orders
         (user_name, retailer, item_name, order_number, tracking_number, carrier, status, expected_date, order_total, email_id, order_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_name, email_id)
       WHERE email_id IS NOT NULL
       DO UPDATE SET
         retailer        = EXCLUDED.retailer,
         item_name       = EXCLUDED.item_name,
         order_number    = COALESCE(EXCLUDED.order_number, orders.order_number),
         tracking_number = COALESCE(EXCLUDED.tracking_number, orders.tracking_number),
         carrier         = COALESCE(EXCLUDED.carrier, orders.carrier),
         order_total     = COALESCE(EXCLUDED.order_total, orders.order_total),
         order_url       = COALESCE(EXCLUDED.order_url, orders.order_url),
         updated_at      = now()
       RETURNING *`,
      [
        userName,
        order.retailer, order.item_name,
        order.order_number ?? null, order.tracking_number ?? null,
        order.carrier ?? null, order.status ?? "ordered",
        order.expected_date ?? null, order.order_total ?? null,
        order.email_id ?? null, order.order_url ?? null,
      ]
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, order }, "[Orders] upsertOrder failed");
    return null;
  }
}

// ── Post-scan consolidation ───────────────────────────────────────────────────
// After a Gmail scan, multiple emails for the same package may have produced
// duplicate rows (one per email_id).  This function merges them:
//   1. If two rows share a tracking_number, keep the highest-status one, delete the rest.
//   2. If a row has a tracking_number AND another row has the same order_number but
//      no tracking_number, delete the no-tracking orphan (it was already merged via
//      upsertOrder for new syncs, but old rows from previous syncs need cleanup too).
export async function consolidateOrders(userName: string): Promise<number> {
  let deleted = 0;

  // Step 1: deduplicate by tracking_number — keep the row with the highest status.
  const { rows: tnDups } = await query<{ tracking_number: string; keep_id: number }>(
    `SELECT tracking_number,
            (array_agg(id ORDER BY
              CASE status
                WHEN 'out_for_delivery' THEN 5
                WHEN 'delivered'        THEN 4
                WHEN 'in_transit'       THEN 3
                WHEN 'shipped'          THEN 2
                WHEN 'ordered'          THEN 1
                ELSE 0
              END DESC, updated_at DESC
            ))[1] AS keep_id
     FROM orders
     WHERE user_name = $1 AND tracking_number IS NOT NULL
     GROUP BY tracking_number
     HAVING COUNT(*) > 1`,
    [userName]
  );

  for (const { tracking_number, keep_id } of tnDups) {
    const { rows: gone } = await query<{ id: number }>(
      `DELETE FROM orders
       WHERE user_name = $1 AND tracking_number = $2 AND id != $3
       RETURNING id`,
      [userName, tracking_number, keep_id]
    );
    deleted += gone.length;
    if (gone.length > 0) {
      logger.info(
        { userName, tracking_number, kept: keep_id, removed: gone.map((r) => r.id) },
        "[Orders] Consolidated duplicate tracking-number rows"
      );
    }
  }

  // Step 2: remove orphan no-tracking rows where a tracking row exists for the same order_number.
  const { rows: orphans } = await query<{ id: number }>(
    `DELETE FROM orders orphan
     USING orders tracked
     WHERE orphan.user_name    = $1
       AND orphan.tracking_number IS NULL
       AND orphan.order_number IS NOT NULL
       AND tracked.user_name   = $1
       AND tracked.tracking_number IS NOT NULL
       AND tracked.order_number = orphan.order_number
     RETURNING orphan.id`,
    [userName]
  );
  deleted += orphans.length;
  if (orphans.length > 0) {
    logger.info(
      { userName, removed: orphans.map((r) => r.id) },
      "[Orders] Removed orphan no-tracking rows that have a tracked sibling"
    );
  }

  // Step 3: deduplicate by email_id — same email parsed multiple times creates ghost rows.
  // Keep the most complete row (has tracking_number > has order_number > most recent).
  const { rows: emailDups } = await query<{ email_id: string; keep_id: number }>(
    `SELECT email_id,
            (array_agg(id ORDER BY
              CASE WHEN tracking_number IS NOT NULL THEN 2
                   WHEN order_number    IS NOT NULL THEN 1
                   ELSE 0
              END DESC, updated_at DESC
            ))[1] AS keep_id
     FROM orders
     WHERE user_name = $1 AND email_id IS NOT NULL
     GROUP BY email_id
     HAVING COUNT(*) > 1`,
    [userName]
  );

  for (const { email_id, keep_id } of emailDups) {
    const { rows: gone } = await query<{ id: number }>(
      `DELETE FROM orders
       WHERE user_name = $1 AND email_id = $2 AND id != $3
       RETURNING id`,
      [userName, email_id, keep_id]
    );
    deleted += gone.length;
    if (gone.length > 0) {
      logger.info(
        { userName, email_id, kept: keep_id, removed: gone.map((r) => r.id) },
        "[Orders] Consolidated duplicate email_id rows"
      );
    }
  }

  // Step 4: deduplicate by order_number — same package across multiple emails
  // (e.g. order confirmation + shipping update + delivery notice) creates one row
  // per email even though it's the same physical order.
  // Keep the row with the highest status, then the most recently updated.
  const { rows: orderNumDups } = await query<{ order_number: string; keep_id: number }>(
    `SELECT order_number,
            (array_agg(id ORDER BY
              CASE status
                WHEN 'out_for_delivery' THEN 5
                WHEN 'delivered'        THEN 4
                WHEN 'in_transit'       THEN 3
                WHEN 'shipped'          THEN 2
                WHEN 'ordered'          THEN 1
                ELSE 0
              END DESC, updated_at DESC
            ))[1] AS keep_id
     FROM orders
     WHERE user_name = $1 AND order_number IS NOT NULL
     GROUP BY order_number
     HAVING COUNT(*) > 1`,
    [userName]
  );

  for (const { order_number, keep_id } of orderNumDups) {
    // ── Merge before delete ──────────────────────────────────────────────────
    // The kept row may be missing tracking_number/carrier/expected_date that
    // live on one of the rows being deleted (e.g. the kept row is
    // out_for_delivery from an "OFD" email with no TBA, while the deleted row
    // is in_transit from a shipping email that has the TBA tracking number).
    // Copy those fields into the kept row BEFORE the delete so they aren't lost.
    await query(
      `UPDATE orders kept
       SET
         tracking_number = COALESCE(kept.tracking_number,
           (SELECT tracking_number FROM orders
            WHERE user_name = $1 AND order_number = $2 AND id != $3
              AND tracking_number IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1)),
         carrier = COALESCE(kept.carrier,
           (SELECT carrier FROM orders
            WHERE user_name = $1 AND order_number = $2 AND id != $3
              AND carrier IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1)),
         expected_date = COALESCE(kept.expected_date,
           (SELECT expected_date FROM orders
            WHERE user_name = $1 AND order_number = $2 AND id != $3
              AND expected_date IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1)),
         order_total = COALESCE(kept.order_total,
           (SELECT order_total FROM orders
            WHERE user_name = $1 AND order_number = $2 AND id != $3
              AND order_total IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1)),
         updated_at = now()
       WHERE kept.id = $3 AND kept.user_name = $1`,
      [userName, order_number, keep_id]
    );

    const { rows: gone } = await query<{ id: number }>(
      `DELETE FROM orders
       WHERE user_name = $1 AND order_number = $2 AND id != $3
       RETURNING id`,
      [userName, order_number, keep_id]
    );
    deleted += gone.length;
    if (gone.length > 0) {
      logger.info(
        { userName, order_number, kept: keep_id, removed: gone.map((r) => r.id) },
        "[Orders] Consolidated duplicate order_number rows"
      );
    }
  }

  return deleted;
}

export async function updateOrderTracking(
  id: number,
  update: {
    status?: OrderStatus;
    expected_date?: string | null;
    tracking_events?: TrackingEvent[];
    carrier?: string | null;
    status_color?: string | null;
    status_detail?: string | null;
  }
): Promise<void> {
  await query(
    `UPDATE orders SET
       status = COALESCE($2, status),
       expected_date = CASE WHEN $3::text IS NOT NULL THEN $3::date ELSE expected_date END,
       tracking_events = COALESCE($4::jsonb, tracking_events),
       carrier = COALESCE($5, carrier),
       status_color = COALESCE($6, status_color),
       status_detail = COALESCE($7, status_detail),
       last_tracked_at = now(),
       updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [
      id,
      update.status ?? null,
      update.expected_date ?? null,
      update.tracking_events ? JSON.stringify(update.tracking_events) : null,
      update.carrier ?? null,
      update.status_color ?? null,
      update.status_detail ?? null,
    ]
  );
}

export async function deleteOrder(id: number, userName: string): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `DELETE FROM orders WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

// ── Sync state ─────────────────────────────────────────────────────────────────

export async function getLastOrderScanAt(userName = NATIVE_USER): Promise<Date | null> {
  const { rows } = await query<{ last_scan_at: string | null }>(
    `SELECT last_scan_at FROM order_sync_state WHERE user_name = $1`,
    [userName]
  );
  const val = rows[0]?.last_scan_at;
  return val ? new Date(val) : null;
}

export async function updateLastOrderScanAt(userName = NATIVE_USER): Promise<void> {
  await query(
    `INSERT INTO order_sync_state (user_name, last_scan_at)
     VALUES ($1, now())
     ON CONFLICT (user_name)
     DO UPDATE SET last_scan_at = now()
     RETURNING user_name`,
    [userName]
  );
}

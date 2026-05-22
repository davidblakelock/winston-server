import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { authenticate } from "../auth/middleware.js";

const router: IRouter = Router();

// ── Known service definitions ────────────────────────────────────────────────
// Table is created at server startup in src/index.ts
interface ServiceInfo {
  type: string;
  displayName: string;
}

const KNOWN_SERVICES: Record<string, ServiceInfo> = {
  instacart:    { type: "grocery",  displayName: "Instacart" },
  walmart:      { type: "grocery",  displayName: "Walmart" },
  heb:          { type: "grocery",  displayName: "H-E-B" },
  kroger:       { type: "grocery",  displayName: "Kroger" },
  shipt:        { type: "grocery",  displayName: "Shipt" },
  amazon_fresh: { type: "grocery",  displayName: "Amazon Fresh" },
  garmin:       { type: "health",   displayName: "Garmin" },
  oura:         { type: "health",   displayName: "Oura Ring" },
  fitbit:       { type: "health",   displayName: "Fitbit" },
  google_fit:   { type: "health",   displayName: "Google Fit" },
  amazon:       { type: "shopping", displayName: "Amazon" },
};

// ── GET /api/integrations ────────────────────────────────────────────────────
// Returns all known services with their connected/preferred status for this user.
router.get("/integrations", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const { rows } = await query<{
      service_name: string;
      service_type: string;
      is_connected: boolean;
      preferred: boolean;
    }>(
      `SELECT service_name, service_type, is_connected, preferred
       FROM user_service_preferences WHERE user_name = $1`,
      [userName]
    );

    const connected = new Map(rows.map((r) => [r.service_name, r]));

    const integrations = Object.entries(KNOWN_SERVICES).map(([name, info]) => ({
      serviceName: name,
      serviceType: info.type,
      displayName: info.displayName,
      isConnected: connected.get(name)?.is_connected ?? false,
      preferred:   connected.get(name)?.preferred   ?? false,
    }));

    res.json({ integrations });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

// ── GET /api/integrations/preferred/:type ────────────────────────────────────
// Returns the preferred connected service for a given type (e.g. "grocery").
router.get("/integrations/preferred/:type", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { type } = req.params as { type: string };

  try {
    const { rows } = await query<{ service_name: string }>(
      `SELECT service_name FROM user_service_preferences
       WHERE user_name = $1 AND service_type = $2 AND preferred = true AND is_connected = true
       LIMIT 1`,
      [userName, type]
    );

    if (rows.length === 0) {
      res.json({ service_name: null, display_name: null });
      return;
    }

    const svcName = rows[0]!.service_name;
    res.json({ service_name: svcName, display_name: KNOWN_SERVICES[svcName]?.displayName ?? svcName });
  } catch (err) {
    res.status(500).json({ error: "Failed to get preferred integration" });
  }
});

// ── POST /api/integrations/:service/connect ──────────────────────────────────
// Marks a service as connected for the user.
// Accepts optional { preferred: true } in the body — if set, also clears preferred
// from all other services of the same type and marks this one as preferred.
router.post("/integrations/:service/connect", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { service } = req.params as { service: string };
  const info = KNOWN_SERVICES[service];
  if (!info) {
    res.status(400).json({ error: `Unknown service: ${service}` });
    return;
  }

  const setPreferred = req.body?.preferred === true;

  try {
    if (setPreferred) {
      // Clear preferred from all other services of the same type first
      await query(
        `UPDATE user_service_preferences
           SET preferred = false, updated_at = now()
         WHERE user_name = $1 AND service_type = $2`,
        [userName, info.type]
      );
    }

    await query(
      `INSERT INTO user_service_preferences (user_name, service_name, service_type, is_connected, preferred, updated_at)
       VALUES ($1, $2, $3, true, $4, now())
       ON CONFLICT (user_name, service_name) DO UPDATE
         SET is_connected = true,
             preferred    = CASE WHEN $4 THEN true ELSE user_service_preferences.preferred END,
             updated_at   = now()`,
      [userName, service, info.type, setPreferred]
    );
    res.json({ ok: true, service_name: service, is_connected: true, preferred: setPreferred });
  } catch (err) {
    res.status(500).json({ error: "Failed to connect integration" });
  }
});

// ── POST /api/integrations/:service/disconnect ───────────────────────────────
// Marks a service as disconnected (also clears preferred flag).
router.post("/integrations/:service/disconnect", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { service } = req.params as { service: string };

  try {
    await query(
      `UPDATE user_service_preferences
       SET is_connected = false, preferred = false, updated_at = now()
       WHERE user_name = $1 AND service_name = $2`,
      [userName, service]
    );
    res.json({ ok: true, serviceName: service, isConnected: false });
  } catch (err) {
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

// ── POST /api/integrations/:service/set-preferred ────────────────────────────
// Sets a service as the preferred option for its type (e.g. preferred grocery store).
// Automatically marks it as connected. Clears preferred from all other services of
// the same type for this user.
router.post("/integrations/:service/set-preferred", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { service } = req.params as { service: string };
  const info = KNOWN_SERVICES[service];
  if (!info) {
    res.status(400).json({ error: `Unknown service: ${service}` });
    return;
  }

  try {
    // Clear preferred for all services of the same type first
    await query(
      `UPDATE user_service_preferences
       SET preferred = false, updated_at = now()
       WHERE user_name = $1 AND service_type = $2`,
      [userName, info.type]
    );

    // Upsert this service as preferred + connected
    await query(
      `INSERT INTO user_service_preferences (user_name, service_name, service_type, is_connected, preferred, updated_at)
       VALUES ($1, $2, $3, true, true, now())
       ON CONFLICT (user_name, service_name) DO UPDATE
         SET preferred = true, is_connected = true, updated_at = now()`,
      [userName, service, info.type]
    );

    res.json({ ok: true, serviceName: service, preferred: true, displayName: info.displayName });
  } catch (err) {
    res.status(500).json({ error: "Failed to set preferred integration" });
  }
});

export default router;

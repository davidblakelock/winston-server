import { Router, type IRouter } from "express";
import { query } from "../db.js";

const router: IRouter = Router();

// GET /api/health — detailed health check used by the frontend keep-alive ping.
// Returns db connectivity, uptime, and timestamp so the client can detect staleness.
router.get("/health", async (_req, res) => {
  const start = Date.now();
  let dbOk = false;
  let dbLatencyMs = -1;

  try {
    const dbStart = Date.now();
    await query("SELECT 1");
    dbLatencyMs = Date.now() - dbStart;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    db: dbOk ? "ok" : "error",
    dbLatencyMs,
    latencyMs: Date.now() - start,
  });
});

// Legacy endpoint — keep for backward compatibility
router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

export default router;

import { Router, type IRouter } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

// Injected by esbuild at compile time — reflects the moment the binary was built.
// Falls back to a sentinel so the value is always present and testable.
declare const __BUILD_TIME__: string;
const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev-unbuilt";

const PROCESS_START = new Date().toISOString();

let _schedulersEnabled = false;
export function setSchedulersEnabled(): void {
  _schedulersEnabled = true;
}

const router: IRouter = Router();

// GET /api/version — returns build timestamp, process start time, and pid.
// Use this immediately after deploying to confirm the new binary is live.
// Example: curl https://winston-companion--davidblakelock.replit.app/api/version
router.get("/version", (_req, res) => {
  res.json({
    buildTime:   BUILD_TIME,
    startTime:   PROCESS_START,
    uptimeSeconds: Math.round(process.uptime()),
    pid:         process.pid,
    nodeVersion: process.version,
  });
});

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
    status:       "ok",
    buildTime:    BUILD_TIME,
    startTime:    PROCESS_START,
    timestamp:    new Date().toISOString(),
    uptime:       Math.round(process.uptime()),
    db:           dbOk ? "ok" : "error",
    dbLatencyMs,
    latencyMs:    Date.now() - start,
  });
});

// Lightweight liveness probe — used by the deployment health check.
router.get("/healthz", (_req, res) =>
  res.json({
    status: "ok",
    buildTime: BUILD_TIME,
    schedulers: _schedulersEnabled ? "running" : "disabled",
    railway: !!process.env.RAILWAY_ENVIRONMENT,
  })
);

// GET /api/diag/claude — tests Anthropic key and both model names.
router.get("/diag/claude", async (_req, res) => {
  const keySet = !!process.env.ANTHROPIC_API_KEY;
  if (!keySet) {
    res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY is not set" });
    return;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results: Record<string, unknown> = { keySet: true };
  for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"] as const) {
    try {
      const r = await client.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "Say OK" }],
      });
      results[model] = { ok: true, response: r.content[0]?.type === "text" ? r.content[0].text : "(empty)" };
    } catch (err) {
      results[model] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const allOk = Object.values(results).every((v) => typeof v !== "object" || (v as Record<string,unknown>).ok !== false);
  res.status(allOk ? 200 : 500).json({ ok: allOk, ...results });
});

// GET /api/diag/openai — tests OpenAI key presence and GPT-4o reachability.
// Hit this in a browser to confirm the key is set and the model responds.
router.get("/diag/openai", async (_req, res) => {
  const keySet = !!process.env.OPENAI_API_KEY;
  if (!keySet) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set in environment" });
    return;
  }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say OK" }],
    });
    const text = resp.choices[0]?.message?.content ?? "(empty)";
    res.json({ ok: true, keySet: true, model: "gpt-4o", response: text });
  } catch (err) {
    res.status(500).json({
      ok: false,
      keySet: true,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;

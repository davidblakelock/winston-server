import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { NATIVE_API_KEY, NATIVE_USER } from "../auth/middleware.js";
import {
  connectGarmin,
  disconnectGarmin,
  getGarminStatus,
  fetchAndStoreGarminData,
} from "../garmin/garminService.js";

const router = Router();

async function resolveUser(req: Request): Promise<string | null> {
  const apiKey = req.headers["x-api-key"];
  if (apiKey === NATIVE_API_KEY) {
    const headerUser = req.headers["x-user-name"];
    return (typeof headerUser === "string" && headerUser.trim()) ? headerUser.trim() : NATIVE_USER;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const session = await validateSession(authHeader.slice(7));
  return session?.userName ?? null;
}

// GET /api/garmin/status
router.get("/garmin/status", async (req: Request, res: Response) => {
  const userName = await resolveUser(req);
  if (!userName) { res.status(401).json({ error: "Not authenticated" }); return; }

  const status = await getGarminStatus(userName);
  res.json(status);
});

// POST /api/garmin/connect
router.post("/garmin/connect", async (req: Request, res: Response) => {
  const userName = await resolveUser(req);
  if (!userName) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const result = await connectGarmin(userName, email.trim(), password);
  if (!result.ok) {
    res.status(401).json({ error: result.error ?? "Garmin authentication failed" });
    return;
  }

  // Trigger immediate data sync for yesterday in the background
  fetchAndStoreGarminData(userName).catch(() => {});

  res.json({ ok: true, message: "Garmin account connected" });
});

// POST /api/garmin/disconnect
router.post("/garmin/disconnect", async (req: Request, res: Response) => {
  const userName = await resolveUser(req);
  if (!userName) { res.status(401).json({ error: "Not authenticated" }); return; }

  await disconnectGarmin(userName);
  res.json({ ok: true });
});

// POST /api/garmin/sync — manual data sync (fetches yesterday)
router.post("/garmin/sync", async (req: Request, res: Response) => {
  const userName = await resolveUser(req);
  if (!userName) { res.status(401).json({ error: "Not authenticated" }); return; }

  const status = await getGarminStatus(userName);
  if (!status.connected) {
    res.status(400).json({ error: "Garmin not connected" });
    return;
  }

  const data = await fetchAndStoreGarminData(userName);
  if (!data) {
    res.status(500).json({ error: "Sync failed — check your Garmin credentials" });
    return;
  }

  res.json({ ok: true, data });
});

export default router;

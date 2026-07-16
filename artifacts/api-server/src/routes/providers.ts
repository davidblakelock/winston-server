import { Router, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  getCategories,
  createCategory,
} from "../providers/providerManager.js";

const router = Router();

// Returns the category string as-is (any non-empty string is valid — the DB
// column is plain TEXT). Falls back to "personal" only when nothing is supplied.
function resolveCategory(v: unknown): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  return "personal";
}

// ── GET /api/providers/categories ─────────────────────────────────────────────
// Returns built-in defaults + any custom categories for the user.
router.get("/providers/categories", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const categories = await getCategories(userName);
    res.json({ categories });
  } catch (err) {
    req.log.error({ err }, "[Providers] GET /providers/categories error");
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// ── POST /api/providers/categories ────────────────────────────────────────────
// Creates a custom category. Returns the record (or the matching default if it
// duplicates a built-in name).
router.post(
  "/providers/categories",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const body = req.body as Record<string, unknown>;
    const categoryName = body["categoryName"] ?? body["category_name"] ?? body["name"];

    if (!categoryName || typeof categoryName !== "string" || !categoryName.trim()) {
      res.status(400).json({ error: "categoryName is required" });
      return;
    }

    try {
      const { record, created } = await createCategory(userName, categoryName);
      req.log.info({ userName, categoryName: record.categoryName, created }, "[Providers] Category upserted");
      res.status(created ? 201 : 200).json({ category: record });
    } catch (err) {
      req.log.error({ err }, "[Providers] POST /providers/categories error");
      res.status(500).json({ error: "Failed to create category" });
    }
  }
);

// ── GET /api/providers ────────────────────────────────────────────────────────
// Returns all providers grouped by category.
router.get("/providers", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const grouped = await getProviders(userName);
    res.json({ providers: grouped });
  } catch (err) {
    req.log.error({ err }, "[Providers] GET /providers error");
    res.status(500).json({ error: "Failed to load providers" });
  }
});

// ── POST /api/providers ───────────────────────────────────────────────────────
// Creates a new service provider.
router.post(
  "/providers",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const body = req.body as Record<string, unknown>;
    const { name, category, specialty, phone, email, address, website, company, notes, lastContactDate, googleContactId } = body;
    const nextDueDate = body["nextDueDate"] ?? body["next_due_date"];

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const cat = resolveCategory(category);

    try {
      const provider = await createProvider(userName, {
        name: name.trim(),
        category: cat,
        specialty: typeof specialty === "string" ? specialty.trim() || null : null,
        phone: typeof phone === "string" ? phone.trim() || null : null,
        email: typeof email === "string" ? email.trim() || null : null,
        address: typeof address === "string" ? address.trim() || null : null,
        website: typeof website === "string" ? website.trim() || null : null,
        company: typeof company === "string" ? company.trim() || null : null,
        notes: typeof notes === "string" ? notes.trim() || null : null,
        lastContactDate: typeof lastContactDate === "string" ? lastContactDate : null,
        nextDueDate: typeof nextDueDate === "string" ? nextDueDate : null,
        googleContactId: typeof googleContactId === "string" ? googleContactId : null,
      });
      req.log.info({ userName, id: provider.id, name: provider.name }, "[Providers] Created");
      res.status(201).json({ provider });
    } catch (err) {
      req.log.error({ err }, "[Providers] POST /providers error");
      res.status(500).json({ error: "Failed to create provider" });
    }
  }
);

// ── PUT /api/providers/:id ────────────────────────────────────────────────────
// Updates a provider.
router.put(
  "/providers/:id",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const id = parseInt(String(req.params["id"] ?? ""), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const updates: Parameters<typeof updateProvider>[2] = {};

    if (body["name"] !== undefined)            updates.name            = String(body["name"]).trim();
    if (body["category"] !== undefined)        updates.category        = resolveCategory(body["category"]);
    if (body["specialty"] !== undefined)       updates.specialty       = body["specialty"] ? String(body["specialty"]) : null;
    if (body["phone"] !== undefined)           updates.phone           = body["phone"] ? String(body["phone"]) : null;
    if (body["email"] !== undefined)           updates.email           = body["email"] ? String(body["email"]) : null;
    if (body["address"] !== undefined)         updates.address         = body["address"] ? String(body["address"]) : null;
    if (body["website"] !== undefined)         updates.website         = body["website"] ? String(body["website"]) : null;
    if (body["company"] !== undefined)         updates.company         = body["company"] ? String(body["company"]) : null;
    if (body["notes"] !== undefined)           updates.notes           = body["notes"] ? String(body["notes"]) : null;
    if (body["lastContactDate"] !== undefined) updates.lastContactDate = body["lastContactDate"] ? String(body["lastContactDate"]) : null;
    const nextDueRaw = body["nextDueDate"] !== undefined ? body["nextDueDate"] : body["next_due_date"];
    if (nextDueRaw !== undefined)              updates.nextDueDate     = nextDueRaw ? String(nextDueRaw) : null;
    if (body["googleContactId"] !== undefined) updates.googleContactId = body["googleContactId"] ? String(body["googleContactId"]) : null;

    try {
      const provider = await updateProvider(id, userName, updates);
      if (!provider) {
        res.status(404).json({ error: "Provider not found" });
        return;
      }
      req.log.info({ userName, id }, "[Providers] Updated");
      res.json({ provider });
    } catch (err) {
      req.log.error({ err }, "[Providers] PUT /providers/:id error");
      res.status(500).json({ error: "Failed to update provider" });
    }
  }
);

// ── DELETE /api/providers/:id ─────────────────────────────────────────────────
router.delete("/providers/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  try {
    const deleted = await deleteProvider(id, userName);
    if (!deleted) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    req.log.info({ userName, id }, "[Providers] Deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Providers] DELETE /providers/:id error");
    res.status(500).json({ error: "Failed to delete provider" });
  }
});

export default router;

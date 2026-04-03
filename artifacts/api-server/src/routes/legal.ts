import { Router, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public"
);

router.get("/privacy", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=\"Winston_Privacy_Policy.pdf\"");
  res.sendFile(path.join(publicDir, "Winston_Privacy_Policy.pdf"), (err) => {
    if (err) res.status(404).json({ error: "Privacy policy not found" });
  });
});

router.get("/terms", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=\"Winston_Terms_of_Service.pdf\"");
  res.sendFile(path.join(publicDir, "Winston_Terms_of_Service.pdf"), (err) => {
    if (err) res.status(404).json({ error: "Terms of service not found" });
  });
});

export default router;

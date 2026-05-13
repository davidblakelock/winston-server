import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// Allow Google OAuth popups to communicate with the parent window.
// Without this, COOP blocks cross-origin postMessage from the popup.
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

app.use(express.json({ limit: "70mb" }));
app.use(express.urlencoded({ limit: "70mb", extended: true }));

// Serve static files from the public folder
const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public");
app.use(express.static(publicDir));

// Legal document routes
app.get("/privacy", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/pdf");
  res.sendFile(path.join(publicDir, "Winston_Privacy_Policy.pdf"));
});

app.get("/terms", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/pdf");
  res.sendFile(path.join(publicDir, "Winston_Terms_of_Service.pdf"));
});

app.use("/api", router);

export default app;

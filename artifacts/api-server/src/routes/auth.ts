import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import { createOAuthClient, getRedirectUri, SCOPES } from "../google/oauth.js";
import { query } from "../db.js";

const router = Router();

router.get("/auth/google", (_req: Request, res: Response) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    login_hint: "davidblakelock.winston@gmail.com",
  });
  res.redirect(url);
});

router.get("/auth/callback", async (req: Request, res: Response) => {
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect("/?auth=error");
    return;
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email ?? null;

    await query(
      `INSERT INTO google_auth (user_name, email, access_token, refresh_token, token_expiry, scope)
       VALUES ('David', $1, $2, $3, $4, $5)
       ON CONFLICT (user_name) DO UPDATE SET
         email        = EXCLUDED.email,
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, google_auth.refresh_token),
         token_expiry = EXCLUDED.token_expiry,
         scope        = EXCLUDED.scope,
         updated_at   = NOW()`,
      [
        email,
        tokens.access_token ?? null,
        tokens.refresh_token ?? null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        SCOPES.join(" "),
      ]
    );

    req.log.info({ email }, "Google OAuth connected");
    res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
      <script>
        if (window.opener) { window.opener.postMessage('google-connected', '*'); window.close(); }
        else { window.location.href = '/?connected=google'; }
      </script>
      <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#4ade80">Google connected! You can close this window.</p>
    </body></html>`);
  } catch (err) {
    req.log.error({ err }, "Google OAuth callback error");
    res.send(`<!DOCTYPE html><html><head><title>Error</title></head><body>
      <script>
        if (window.opener) { window.opener.postMessage('google-auth-error', '*'); window.close(); }
        else { window.location.href = '/?auth=error'; }
      </script>
      <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#f87171">Sign-in failed. You can close this window.</p>
    </body></html>`);
  }
});

router.get("/auth/status", async (_req: Request, res: Response) => {
  try {
    const { rows } = await query<{ email: string | null; token_expiry: Date | null }>(
      "SELECT email, token_expiry FROM google_auth WHERE user_name = 'David' LIMIT 1"
    );
    if (rows.length === 0 || !rows[0].email) {
      res.json({ connected: false });
      return;
    }
    res.json({ connected: true, email: rows[0].email });
  } catch {
    res.json({ connected: false });
  }
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM google_auth WHERE user_name = 'David'");
    req.log.info("Google OAuth disconnected");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Logout error");
    res.status(500).json({ error: "Logout failed" });
  }
});

export { getRedirectUri };
export default router;

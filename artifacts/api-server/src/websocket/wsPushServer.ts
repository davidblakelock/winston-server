// WebSocket replacement for the legacy SSE push channel (routes/reminders.ts's
// sseHandler). Confirmed live (curl trace against this same server held a
// plain HTTPS connection open for 90s with clean 25s heartbeats, closed only
// by the client's own timer — proving the server/Railway side was never the
// problem) that react-native-sse's XHR-based transport reconnects roughly
// every 5 seconds on Android regardless of server behavior, and any
// broadcast landing in one of those reconnect gaps was silently and
// permanently lost, with no replay. WebSocket has first-class native support
// on React Native (not XHR-based) and doesn't share that limitation.
//
// Deliberately runs ALONGSIDE the legacy SSE route, not replacing it — the
// native client switch to WebSocket only reaches a device once a new build
// is installed, and the currently-installed build still needs SSE to keep
// working until then. Both transports funnel through the same
// broadcast()/broadcastToUser() calls in sseStore.ts via the shared
// PushClient interface, so removing SSE later (once every installed build
// is confirmed on WebSocket) only touches this file and routes/reminders.ts
// — none of the ~40 call sites that actually broadcast events.
import { randomUUID } from "crypto";
import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { addClient, removeClient, registerClientUser, type PushClient } from "../reminders/sseStore.js";
import { validateSession } from "../auth/sessionAuth.js";
import { logger } from "../lib/logger.js";

const WS_PATH = "/api/ws";

// Same 25s cadence as the SSE heartbeat, but using real WebSocket ping/pong
// control frames instead of a synthetic comment — the client's WebSocket
// implementation answers pings automatically at the protocol level, no app
// code needed on that side. A connection that misses a pong (dead socket,
// not just idle) gets terminated outright rather than left as a phantom
// registration that would eat future broadcasts silently.
const HEARTBEAT_INTERVAL_MS = 25_000;

interface LivenessTrackedSocket extends WebSocket {
  isAlive?: boolean;
}

class WSPushClient implements PushClient {
  constructor(private ws: WebSocket) {}
  send(event: string, data: unknown): void {
    this.ws.send(JSON.stringify({ type: event, data }));
  }
  close(): void {
    try { this.ws.close(); } catch { /* already dead */ }
  }
}

export function setupWebSocketServer(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on("connection", async (ws: LivenessTrackedSocket, req) => {
    const clientId = randomUUID();
    const url = new URL(req.url ?? "", "http://internal");
    const token = url.searchParams.get("token");
    const deviceId = url.searchParams.get("deviceId");

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    addClient(clientId, new WSPushClient(ws), deviceId);

    if (token) {
      try {
        const session = await validateSession(token);
        if (session?.userName) registerClientUser(clientId, session.userName);
      } catch { /* non-fatal — client just won't get user-scoped events */ }
    }

    ws.on("close", () => removeClient(clientId));
    // A socket that errors without a clean close would otherwise sit in the
    // registry as a dead entry silently eating broadcasts — mirrors why SSE
    // needed deviceId-based eviction as a second line of defense.
    ws.on("error", () => removeClient(clientId));
  });

  const heartbeat = setInterval(() => {
    for (const raw of wss.clients) {
      const ws = raw as LivenessTrackedSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeat));

  logger.info({ path: WS_PATH }, "[WS] WebSocket push server attached");
}

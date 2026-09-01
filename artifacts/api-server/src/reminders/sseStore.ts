// Transport-agnostic push client registry. Originally SSE-only; now backs
// both the legacy SSE connections (routes/reminders.ts, kept alive only
// until every installed app build has switched to WebSocket — see
// websocket/wsPushServer.ts's module comment) and the new WebSocket
// connections, behind the same PushClient interface, so every one of the
// ~40 broadcast()/broadcastToUser() call sites elsewhere in the codebase
// needed zero changes for the migration.
export interface PushClient {
  send(event: string, data: unknown): void;
  close(): void;
}

const clients = new Map<string, PushClient>();
const clientUsers = new Map<string, string>(); // clientId → userName
// clientId → deviceId. Populated at connect time (unlike clientUsers, which
// waits on an async session lookup) — this is what lets a reconnect evict
// its own predecessor immediately, before that predecessor has necessarily
// even been user-registered yet.
const clientDevices = new Map<string, string>();

export function addClient(id: string, client: PushClient, deviceId?: string | null): void {
  // A client's own reconnect (network blip, backgrounding, app relaunch)
  // does not reliably deliver a clean disconnect to the server for the
  // connection it's replacing — confirmed live: a second connection for
  // the same user opened while the first was still registered, and every
  // broadcast for the rest of that session went to both. One went to a
  // socket nobody was listening on, the other reached whichever component
  // instance's onSpeakSync handler raced it — both are equally real
  // failure modes (a wasted push, or two independent playback attempts on
  // the same device fighting over audio focus). Evicting any existing
  // connection for the same deviceId on connect keeps exactly one live
  // connection per physical device — a genuinely different device (its own
  // deviceId) is untouched and keeps its own connection. Applies equally
  // regardless of which transport either connection is on.
  if (deviceId) {
    for (const [existingId, existingDeviceId] of clientDevices) {
      if (existingDeviceId === deviceId && existingId !== id) {
        const stale = clients.get(existingId);
        try { stale?.close(); } catch { /* already dead */ }
        clients.delete(existingId);
        clientUsers.delete(existingId);
        clientDevices.delete(existingId);
        console.log(`Push: evicted stale connection id=${existingId} for deviceId=${deviceId} — superseded by id=${id}`);
      }
    }
    clientDevices.set(id, deviceId);
  }
  clients.set(id, client);
  console.log(`Push: client connected id=${id} deviceId=${deviceId ?? "unknown"} — total connected: ${clients.size}`);
}

export function removeClient(id: string): void {
  clients.delete(id);
  clientUsers.delete(id);
  clientDevices.delete(id);
  console.log(`Push: client disconnected id=${id} — total connected: ${clients.size}`);
}

export function registerClientUser(clientId: string, userName: string): void {
  clientUsers.set(clientId, userName);
  console.log(`Push: registered user="${userName}" for clientId=${clientId}`);
}

export function broadcast(event: string, data: unknown): void {
  const total = clients.size;
  let sent = 0;
  let failed = 0;
  for (const [clientId, client] of clients) {
    try {
      client.send(event, data);
      sent++;
    } catch {
      failed++;
      console.warn(`Push: broadcast send failed for client ${clientId} — removing stale connection`);
      clients.delete(clientId);
      clientUsers.delete(clientId);
      clientDevices.delete(clientId);
    }
  }
  console.log(`Push: broadcast event="${event}" — sent to ${sent}/${total} clients${failed > 0 ? ` (${failed} stale removed)` : ""}`);
}

export function broadcastToUser(userName: string, event: string, data: unknown): void {
  let sent = 0;
  for (const [clientId, client] of clients) {
    if (clientUsers.get(clientId) !== userName) continue;
    try {
      client.send(event, data);
      sent++;
    } catch {
      console.warn(`Push: broadcastToUser send failed for client ${clientId} — removing stale`);
      clients.delete(clientId);
      clientUsers.delete(clientId);
      clientDevices.delete(clientId);
    }
  }
  console.log(`Push: broadcastToUser user="${userName}" event="${event}" — sent to ${sent} clients`);
}

export function clientCount(): number {
  return clients.size;
}

import type { Response } from "express";

const clients = new Map<string, Response>();
const clientUsers = new Map<string, string>(); // clientId → userName

export function addClient(id: string, res: Response): void {
  clients.set(id, res);
  console.log(`SSE: client connected id=${id} — total connected: ${clients.size}`);
}

export function removeClient(id: string): void {
  clients.delete(id);
  clientUsers.delete(id);
  console.log(`SSE: client disconnected id=${id} — total connected: ${clients.size}`);
}

export function registerClientUser(clientId: string, userName: string): void {
  clientUsers.set(clientId, userName);
  console.log(`SSE: registered user="${userName}" for clientId=${clientId}`);
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const total = clients.size;
  let sent = 0;
  let failed = 0;
  for (const [clientId, res] of clients) {
    try {
      res.write(payload);
      (res as unknown as { flush?: () => void }).flush?.();
      sent++;
    } catch {
      failed++;
      console.warn(`SSE: broadcast write failed for client ${clientId} — removing stale connection`);
      clients.delete(clientId);
      clientUsers.delete(clientId);
    }
  }
  console.log(`SSE: broadcast event="${event}" — sent to ${sent}/${total} clients${failed > 0 ? ` (${failed} stale removed)` : ""}`);
}

export function broadcastToUser(userName: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let sent = 0;
  for (const [clientId, res] of clients) {
    if (clientUsers.get(clientId) !== userName) continue;
    try {
      res.write(payload);
      (res as unknown as { flush?: () => void }).flush?.();
      sent++;
    } catch {
      console.warn(`SSE: broadcastToUser write failed for client ${clientId} — removing stale`);
      clients.delete(clientId);
      clientUsers.delete(clientId);
    }
  }
  console.log(`SSE: broadcastToUser user="${userName}" event="${event}" — sent to ${sent} clients`);
}

export function clientCount(): number {
  return clients.size;
}

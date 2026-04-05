import type { Response } from "express";

const clients = new Map<string, Response>();

export function addClient(id: string, res: Response): void {
  clients.set(id, res);
  console.log(`SSE: client connected id=${id} — total connected: ${clients.size}`);
}

export function removeClient(id: string): void {
  clients.delete(id);
  console.log(`SSE: client disconnected id=${id} — total connected: ${clients.size}`);
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const total = clients.size;
  let sent = 0;
  let failed = 0;
  for (const [clientId, res] of clients) {
    try {
      res.write(payload);
      // flush() forces the data through any proxy/compression buffer immediately.
      // Without this, SSE events can sit in the socket buffer and never arrive on mobile.
      (res as unknown as { flush?: () => void }).flush?.();
      sent++;
    } catch {
      failed++;
      console.warn(`SSE: broadcast write failed for client ${clientId} — removing stale connection`);
      clients.delete(clientId);
    }
  }
  console.log(`SSE: broadcast event="${event}" — sent to ${sent}/${total} clients${failed > 0 ? ` (${failed} stale removed)` : ""}`);
}

export function clientCount(): number {
  return clients.size;
}

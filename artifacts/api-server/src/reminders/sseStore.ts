import type { Response } from "express";

const clients = new Map<string, Response>();

export function addClient(id: string, res: Response): void {
  clients.set(id, res);
}

export function removeClient(id: string): void {
  clients.delete(id);
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, res] of clients) {
    try {
      res.write(payload);
    } catch {
    }
  }
}

export function clientCount(): number {
  return clients.size;
}

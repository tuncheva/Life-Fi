// WebSocket hub for /ws/live (contracts/api.md). Server → client only.
// Slow clients are dropped when their send buffer exceeds 64 KB (plan-v2 §7.1).
import type { WebSocket } from "ws";

const MAX_BUFFERED = 64 * 1024;

export class LiveHub {
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly log: { warn: (o: unknown, msg?: string) => void }) {}

  add(sock: WebSocket, hello: unknown[]): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => this.sockets.delete(sock));
    for (const m of hello) this.sendTo(sock, JSON.stringify(m));
  }

  size(): number {
    return this.sockets.size;
  }

  broadcast(message: unknown): void {
    if (this.sockets.size === 0) return;
    const text = JSON.stringify(message);
    for (const sock of this.sockets) this.sendTo(sock, text);
  }

  private sendTo(sock: WebSocket, text: string): void {
    if (sock.readyState !== sock.OPEN) return;
    if (sock.bufferedAmount > MAX_BUFFERED) {
      this.log.warn({ buffered: sock.bufferedAmount }, "dropping slow websocket client");
      sock.close(1008, "too slow");
      this.sockets.delete(sock);
      return;
    }
    sock.send(text);
  }

  closeAll(): void {
    for (const sock of this.sockets) sock.close(1001, "server shutting down");
    this.sockets.clear();
  }
}

// Server-Sent Events hub for /api/v1/live (contracts/api.md). Server → client only.
// Slow clients are dropped when their queue exceeds 64 KB (plan-v2 §7.1).
const MAX_QUEUED = 64 * 1024;
const encoder = new TextEncoder();

type Client = ReadableStreamDefaultController<Uint8Array>;

export class LiveHub {
  /** Each open stream with its keep-alive timer. */
  private readonly clients = new Map<Client, ReturnType<typeof setInterval>>();

  constructor(private readonly log: { warn: (o: unknown, msg?: string) => void }) {}

  /** A new SSE stream: `hello` goes out first, then every broadcast until the client leaves. */
  stream(hello: unknown[]): ReadableStream<Uint8Array> {
    let self: Client | null = null;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          self = controller;
          // a comment line keeps proxies and the browser from timing the stream out
          this.clients.set(controller, setInterval(() => this.sendTo(controller, ": ping\n\n"), 15_000));
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
          for (const m of hello) this.sendTo(controller, `data: ${JSON.stringify(m)}\n\n`);
        },
        cancel: () => {
          if (self) this.forget(self);
        },
      },
      { highWaterMark: MAX_QUEUED, size: (chunk) => chunk.byteLength },
    );
  }

  size(): number {
    return this.clients.size;
  }

  broadcast(message: unknown): void {
    if (this.clients.size === 0) return;
    const text = `data: ${JSON.stringify(message)}\n\n`;
    for (const c of this.clients.keys()) this.sendTo(c, text);
  }

  private sendTo(c: Client, text: string): void {
    if (c.desiredSize !== null && c.desiredSize <= 0) {
      this.log.warn({ queued: MAX_QUEUED - c.desiredSize }, "dropping slow live client");
      this.drop(c);
      return;
    }
    try {
      c.enqueue(encoder.encode(text));
    } catch {
      this.forget(c); // already closed
    }
  }

  private forget(c: Client): void {
    const beat = this.clients.get(c);
    if (beat) clearInterval(beat);
    this.clients.delete(c);
  }

  private drop(c: Client): void {
    this.forget(c);
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }

  closeAll(): void {
    for (const c of [...this.clients.keys()]) this.drop(c);
  }
}

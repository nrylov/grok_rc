import WebSocket from "ws";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type AgentHandlers = {
  request: (message: AgentRequest) => void;
  notification: (message: AgentNote) => void;
  close: () => void;
};

export type AgentRequest = { id: number; method: string; params: Record<string, unknown> };
export type AgentNote = { method: string; params: Record<string, unknown> };

export class AgentClient {
  private ws: WebSocket | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private handlers: AgentHandlers = { request() {}, notification() {}, close() {} };

  constructor(private readonly url: string) {}

  setHandlers(handlers: AgentHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 32 * 1024 * 1024, handshakeTimeout: 10_000 });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("timed out connecting to the grok agent"));
      }, 12_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        this.failAll(new Error("agent disconnected"));
        this.handlers.close();
      });
    });
  }

  close() {
    this.ws?.close();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  reply(id: number, result: unknown) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  replyError(id: number, message: string) {
    this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: message.slice(0, 500) } });
  }

  private onMessage(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
      this.handlers.request({ id: Number(id), method, params });
      return;
    }
    if ((typeof id === "number" || typeof id === "string") && ("result" in message || "error" in message)) {
      const pending = this.pending.get(Number(id));
      if (!pending) return;
      this.pending.delete(Number(id));
      clearTimeout(pending.timer);
      if (message.error) {
        const err = message.error as { message?: string };
        pending.reject(new Error(err.message || "agent error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof method === "string") {
      const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
      this.handlers.notification({ method, params });
    }
  }

  private send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("agent is offline");
    this.ws.send(JSON.stringify(payload));
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

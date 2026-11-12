import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import { AgentClient } from "./agent.ts";
import { readTextFile, writeTextFile } from "./files.ts";
import { listSessions, readHistory } from "./sessions.ts";
import { Terminals } from "./terminals.ts";
import type { ClientMsg, ImageBlock, PermissionOption, ServerMsg, SessionSummary } from "./protocol.ts";

type Client = { socket: WebSocket; send: (message: ServerMsg) => void };
type QueueItem = { clientId: string; text: string; images: ImageBlock[]; cwd: string };
type PendingPerm = {
  requestId: string;
  sessionId: string;
  title: string;
  kind: string;
  input: string;
  options: PermissionOption[];
  resolve: (optionId: string | null) => void;
};

const PROMPT_MS = 15 * 60 * 1000;
const PERM_MS = 3 * 60 * 1000;

export type HubOptions = {
  grokBin: string;
  cwd: string;
  agentPort: number;
  agentSecret: string;
  approve: boolean;
  hostName: string;
  logPath: string;
};

export class Hub {
  readonly cwd: string;
  readonly approve: boolean;
  readonly hostName: string;
  private agent: AgentClient | null = null;
  private child: ChildProcess | null = null;
  private clients = new Set<Client>();
  private loaded = new Set<string>();
  private running = new Set<string>();
  private queues = new Map<string, QueueItem[]>();
  private perms = new Map<string, PendingPerm>();
  private terminals = new Terminals();
  private closed = false;
  private generation = 0;
  private activity = new Map<string, string>();
  private titles = new Map<string, Partial<SessionSummary>>();
  private mute = new Set<string>();
  private echo = new Map<string, { expect: string; got: string }>();

  constructor(private readonly options: HubOptions) {
    this.cwd = options.cwd;
    this.approve = options.approve;
    this.hostName = options.hostName;
  }

  async start() {
    await this.bootAgent();
  }

  async stop() {
    this.closed = true;
    this.generation += 1;
    this.agent?.close();
    await this.terminals.shutdown();
    if (this.child && this.child.exitCode == null) {
      this.child.kill("SIGTERM");
      const child = this.child;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
    }
  }

  addClient(socket: WebSocket): Client {
    const client: Client = {
      socket,
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };
    this.clients.add(client);
    client.send({
      type: "hello",
      host: this.hostName,
      cwd: this.cwd,
      approve: this.approve,
      sessions: this.sessions(),
    });
    client.send({ type: "agent", online: Boolean(this.agent?.connected) });
    for (const perm of this.perms.values()) client.send(permMessage(perm));
    socket.on("message", (data) => {
      void this.onClient(client, data.toString());
    });
    socket.on("close", () => this.clients.delete(client));
    return client;
  }

  sessions(): SessionSummary[] {
    const list = listSessions();
    return list.map((session) => {
      const overlay = this.titles.get(session.id);
      const activity = this.running.has(session.id) ? "running" : this.activity.get(session.id) || session.activity;
      return { ...session, ...overlay, id: session.id, activity };
    });
  }

  private broadcast(message: ServerMsg) {
    for (const client of this.clients) client.send(message);
  }

  private async bootAgent() {
    const gen = ++this.generation;
    const bin = this.options.grokBin;
    fs.mkdirSync(path.dirname(this.options.logPath), { recursive: true });
    const log = fs.openSync(this.options.logPath, "a");
    const args = ["agent", "--no-leader"];
    if (this.approve) args.push("--always-approve");
    args.push("serve", "--bind", `127.0.0.1:${this.options.agentPort}`, "--secret", this.options.agentSecret);
    const child = spawn(bin, args, {
      cwd: this.cwd,
      env: { ...process.env, GROK_AGENT_SECRET: this.options.agentSecret },
      stdio: ["ignore", log, log],
      detached: false,
    });
    this.child = child;
    child.on("exit", (code) => {
      if (this.closed || this.generation !== gen) return;
      this.agent = null;
      this.broadcast({ type: "agent", online: false });
      this.broadcast({ type: "error", message: `The grok agent exited (${code ?? "signal"}). Start grok-rc again.` });
    });
    await waitForPort(this.options.agentPort, 20_000);
    if (this.closed || this.generation !== gen) return;
    const client = new AgentClient(
      `ws://127.0.0.1:${this.options.agentPort}/ws?server-key=${encodeURIComponent(this.options.agentSecret)}`,
    );
    client.setHandlers({
      request: (message) => {
        void this.onAgentRequest(message.id, message.method, message.params);
      },
      notification: (message) => this.onAgentNote(message.method, message.params),
      close: () => {
        if (this.agent === client) this.broadcast({ type: "agent", online: false });
      },
    });
    await client.connect();
    if (this.closed || this.generation !== gen) {
      client.close();
      return;
    }
    await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "grok-rc", version: "0.1.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      },
      20_000,
    );
    this.agent = client;
    this.loaded.clear();
    this.broadcast({ type: "agent", online: true });
    void this.refreshFromAgent();
  }

  private async onClient(client: Client, raw: string) {
    let message: ClientMsg;
    try {
      message = JSON.parse(raw) as ClientMsg;
    } catch {
      client.send({ type: "error", message: "Bad message" });
      return;
    }
    try {
      if (message.type === "refresh") {
        await this.refreshFromAgent();
        client.send({ type: "sessions", sessions: this.sessions() });
        return;
      }
      if (message.type === "subscribe") {
        const turns = readHistory(message.sessionId);
        client.send({ type: "history", sessionId: message.sessionId, turns });
        client.send({
          type: "status",
          sessionId: message.sessionId,
          running: this.running.has(message.sessionId),
          label: this.running.has(message.sessionId) ? "Working" : "",
        });
        client.send({ type: "queue", sessionId: message.sessionId, items: this.queueView(message.sessionId) });
        return;
      }
      if (message.type === "permission") {
        this.answerPermission(message.requestId, message.optionId);
        return;
      }
      if (message.type === "cancel") {
        this.agent?.notify("session/cancel", { sessionId: message.sessionId });
        this.queues.set(message.sessionId, []);
        this.broadcast({ type: "queue", sessionId: message.sessionId, items: [] });
        return;
      }
      if (message.type === "drop") {
        const queue = this.queues.get(message.sessionId) || [];
        this.queues.set(
          message.sessionId,
          queue.filter((item) => item.clientId !== message.clientId),
        );
        this.broadcast({ type: "queue", sessionId: message.sessionId, items: this.queueView(message.sessionId) });
        return;
      }
      if (message.type === "new") {
        const cwd = path.resolve(message.cwd || this.cwd);
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("That folder does not exist");
        const created = (await this.mustAgent().request("session/new", { cwd, mcpServers: [] }, 90_000)) as {
          sessionId?: string;
        };
        const sessionId = String(created.sessionId || "");
        if (!sessionId) throw new Error("The agent did not return a session");
        this.loaded.add(sessionId);
        this.titles.set(sessionId, { title: message.text?.trim().slice(0, 80) || "New task", cwd, updatedAt: new Date().toISOString() });
        this.broadcast({ type: "sessions", sessions: this.sessions() });
        client.send({ type: "created", sessionId, cwd });
        client.send({ type: "history", sessionId, turns: [] });
        const text = (message.text || "").trim();
        if (text || (message.images && message.images.length)) {
          await this.enqueue(client, sessionId, cwd, text, message.images || [], message.clientId || "");
        }
        return;
      }
      if (message.type === "prompt") {
        const cwd = this.cwdFor(message.sessionId);
        await this.enqueue(client, message.sessionId, cwd, message.text || "", message.images || [], message.clientId || "");
      }
    } catch (error) {
      client.send({ type: "error", message: errorText(error), sessionId: "sessionId" in message ? message.sessionId : undefined });
    }
  }

  private async enqueue(client: Client, sessionId: string, cwd: string, text: string, images: ImageBlock[], clientId: string) {
    const clean = sanitizeImages(images);
    if (!text.trim() && clean.length === 0) throw new Error("Write a message first");
    const item: QueueItem = { clientId: clientId || `m${Date.now()}`, text, images: clean, cwd };
    if (this.running.has(sessionId)) {
      const queue = this.queues.get(sessionId) || [];
      queue.push(item);
      this.queues.set(sessionId, queue);
      this.broadcast({ type: "queued", sessionId, clientId: item.clientId, text });
      this.broadcast({ type: "queue", sessionId, items: this.queueView(sessionId) });
      return;
    }
    await this.runPrompt(sessionId, item);
  }

  private async runPrompt(sessionId: string, item: QueueItem) {
    this.running.add(sessionId);
    this.activity.set(sessionId, "running");
    if (item.text) this.echo.set(sessionId, { expect: item.text, got: "" });
    this.broadcast({ type: "status", sessionId, running: true, label: "Working" });
    this.broadcast({ type: "sessions", sessions: this.sessions() });
    try {
      await this.ensureLoaded(sessionId, item.cwd);
      const blocks: Record<string, unknown>[] = [];
      if (item.text.trim()) blocks.push({ type: "text", text: item.text });
      for (const image of item.images) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
      const result = (await this.mustAgent().request("session/prompt", { sessionId, prompt: blocks }, PROMPT_MS)) as {
        stopReason?: string;
      };
      this.broadcast({ type: "prompt_done", sessionId, stopReason: String(result?.stopReason || "end_turn") });
    } catch (error) {
      this.broadcast({ type: "error", message: errorText(error), sessionId });
      this.broadcast({ type: "prompt_done", sessionId, stopReason: "error" });
    } finally {
      this.running.delete(sessionId);
      this.echo.delete(sessionId);
      this.activity.set(sessionId, "dormant");
      this.broadcast({ type: "status", sessionId, running: false, label: "" });
      const next = (this.queues.get(sessionId) || []).shift();
      this.broadcast({ type: "queue", sessionId, items: this.queueView(sessionId) });
      this.broadcast({ type: "sessions", sessions: this.sessions() });
      if (next) void this.runPrompt(sessionId, next);
      else void this.refreshFromAgent();
    }
  }

  private async ensureLoaded(sessionId: string, cwd: string) {
    if (this.loaded.has(sessionId)) return;
    this.mute.add(sessionId);
    try {
      await this.mustAgent().request("session/load", { sessionId, cwd, mcpServers: [] }, 60_000);
    } catch {
      /* A session created here is already current. A bad id fails on the prompt that follows. */
    } finally {
      this.mute.delete(sessionId);
    }
    this.loaded.add(sessionId);
  }

  private onAgentNote(method: string, params: Record<string, unknown>) {
    if (method !== "session/update" && method !== "_x.ai/session/update") return;
    const sessionId = String(params.sessionId || "");
    const update = params.update && typeof params.update === "object" ? (params.update as Record<string, unknown>) : null;
    if (!sessionId || !update || this.mute.has(sessionId)) return;
    const kind = String(update.sessionUpdate || "");
    if (kind === "user_message_chunk") {
      const echo = this.echo.get(sessionId);
      if (echo) {
        const content = update.content && typeof update.content === "object" ? (update.content as { text?: string }).text || "" : "";
        echo.got += content;
        if (echo.got.length >= echo.expect.length) this.echo.delete(sessionId);
        return;
      }
    } else if (this.echo.has(sessionId) && kind.startsWith("agent_")) {
      this.echo.delete(sessionId);
    }
    if (!["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(kind)) return;
    if (kind === "tool_call") {
      const title = String(update.title || "Tool");
      this.broadcast({ type: "status", sessionId, running: true, label: title });
    }
    this.broadcast({ type: "update", sessionId, update });
  }

  private async onAgentRequest(id: number, method: string, params: Record<string, unknown>) {
    const agent = this.agent;
    if (!agent) return;
    try {
      if (method === "fs/read_text_file" || method === "fs/readTextFile") {
        agent.reply(id, await readTextFile(params));
        return;
      }
      if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
        agent.reply(id, await writeTextFile(params));
        return;
      }
      if (method === "terminal/create") {
        agent.reply(id, await this.terminals.create(params));
        return;
      }
      if (method === "terminal/output") {
        agent.reply(id, this.terminals.output(params));
        return;
      }
      if (method === "terminal/wait_for_exit" || method === "terminal/waitForExit") {
        agent.reply(id, await this.terminals.wait(params));
        return;
      }
      if (method === "terminal/kill") {
        agent.reply(id, await this.terminals.kill(params));
        return;
      }
      if (method === "terminal/release") {
        agent.reply(id, await this.terminals.release(params));
        return;
      }
      if (method === "session/request_permission" || method === "session/requestPermission") {
        const optionId = await this.askPermission(id, params);
        if (!optionId) agent.reply(id, { outcome: { outcome: "cancelled" } });
        else agent.reply(id, { outcome: { outcome: "selected", optionId } });
        return;
      }
      agent.replyError(id, `unsupported: ${method}`);
    } catch (error) {
      agent.replyError(id, errorText(error));
    }
  }

  private askPermission(requestId: number, params: Record<string, unknown>): Promise<string | null> {
    const options = permissionOptions(params);
    const tool = params.toolCall && typeof params.toolCall === "object" ? (params.toolCall as Record<string, unknown>) : {};
    const allow = options.find((option) => /allow|approve|accept/i.test(`${option.kind} ${option.id}`) && !/always/i.test(`${option.kind} ${option.id}`));
    if (this.approve) return Promise.resolve((allow || options[0])?.id || "allow");
    const key = String(requestId);
    return new Promise((resolve) => {
      const perm: PendingPerm = {
        requestId: key,
        sessionId: String(params.sessionId || ""),
        title: String(tool.title || tool.kind || "Permission"),
        kind: String(tool.kind || ""),
        input: clip(formatInput(tool.rawInput ?? tool.raw_input ?? params), 4000),
        options,
        resolve,
      };
      this.perms.set(key, perm);
      this.broadcast(permMessage(perm));
      setTimeout(() => this.answerPermission(key, null), PERM_MS);
    });
  }

  private answerPermission(requestId: string, optionId: string | null) {
    const perm = this.perms.get(requestId);
    if (!perm) return;
    this.perms.delete(requestId);
    perm.resolve(optionId);
    this.broadcast({ type: "permission_closed", requestId });
  }

  private async refreshFromAgent() {
    if (!this.agent?.connected) {
      this.broadcast({ type: "sessions", sessions: this.sessions() });
      return;
    }
    try {
      const result = (await this.agent.request("_x.ai/sessions/list", {}, 12_000)) as { sessions?: unknown[] };
      for (const item of result.sessions || []) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const id = String(row.sessionId || "");
        if (!id) continue;
        const patch: Partial<SessionSummary> = {};
        if (row.title) patch.title = String(row.title);
        if (row.cwd) patch.cwd = String(row.cwd);
        if (row.modelId) patch.model = String(row.modelId);
        if (row.reasoningEffort) patch.effort = String(row.reasoningEffort);
        if (row.lastChangeUnixMs) patch.updatedAt = new Date(Number(row.lastChangeUnixMs)).toISOString();
        this.titles.set(id, patch);
        if (!this.running.has(id)) this.activity.set(id, String(row.activity || "dormant"));
      }
    } catch {
      /* Disk titles still work. */
    }
    this.broadcast({ type: "sessions", sessions: this.sessions() });
  }

  private queueView(sessionId: string) {
    return (this.queues.get(sessionId) || []).map((item) => ({ clientId: item.clientId, text: item.text }));
  }

  private cwdFor(sessionId: string): string {
    return this.titles.get(sessionId)?.cwd || this.sessions().find((session) => session.id === sessionId)?.cwd || this.cwd;
  }

  private mustAgent(): AgentClient {
    if (!this.agent?.connected) throw new Error("The grok agent is not connected yet");
    return this.agent;
  }
}

function permMessage(perm: PendingPerm): ServerMsg {
  return {
    type: "permission",
    requestId: perm.requestId,
    sessionId: perm.sessionId,
    title: perm.title,
    kind: perm.kind,
    input: perm.input,
    options: perm.options,
  };
}

function permissionOptions(params: Record<string, unknown>): PermissionOption[] {
  const raw = Array.isArray(params.options) ? params.options : [];
  const options = raw
    .map((option) => {
      if (!option || typeof option !== "object") return null;
      const row = option as { optionId?: unknown; id?: unknown; name?: unknown; kind?: unknown };
      const id = String(row.optionId || row.id || "");
      if (!id) return null;
      return { id, name: String(row.name || id), kind: String(row.kind || "") };
    })
    .filter((option): option is PermissionOption => Boolean(option));
  if (options.length) return options;
  return [
    { id: "allow-once", name: "Allow once", kind: "allow_once" },
    { id: "reject-once", name: "Deny", kind: "reject_once" },
  ];
}

function formatInput(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    const content = (record.Content ?? record.content) as { content?: unknown } | undefined;
    if (content && typeof content.content === "string") return content.content;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeImages(images: ImageBlock[]): ImageBlock[] {
  return images.slice(0, 4).filter((image) => {
    if (!/^image\//.test(image.mimeType || "")) return false;
    return typeof image.data === "string" && image.data.length < 4_500_000;
  });
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated]`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`grok agent did not listen on 127.0.0.1:${port}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

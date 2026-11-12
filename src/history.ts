import type { Turn } from "./protocol.ts";

const TEXT_CAP = 80_000;
const TOOL_CAP = 8_000;

type TextKind = "user" | "assistant" | "thought";

export class TurnBuilder {
  turns: Turn[] = [];
  private seq = 0;

  reset(turns: Turn[]) {
    this.turns = turns;
    this.seq = turns.length;
    this.break();
  }

  break() {
    this.open = { user: null, assistant: null, thought: null };
  }
  private open: Record<TextKind, string | null> = { user: null, assistant: null, thought: null };

  apply(update: Record<string, unknown>): Turn | null {
    const kind = String(update.sessionUpdate || "");
    if (kind === "user_message_chunk") return this.text("user", readText(update.content));
    if (kind === "agent_message_chunk") return this.text("assistant", readText(update.content));
    if (kind === "agent_thought_chunk") return this.text("thought", readText(update.content));
    if (kind === "tool_call") return this.tool(update);
    if (kind === "tool_call_update") return this.toolUpdate(update);
    if (kind === "plan") {
      const text = readText(update.content) || readText(update.plan) || stringify(update.entries ?? update.plan);
      if (!text.trim()) return null;
      return this.push({ kind: "system", id: this.nextId("plan"), text: clip(text, TEXT_CAP) });
    }
    return null;
  }

  private text(kind: TextKind, chunk: string): Turn | null {
    if (!chunk) return null;
    const others: TextKind[] = ["user", "assistant", "thought"];
    for (const k of others) if (k !== kind) this.open[k] = null;
    const id = this.open[kind];
    if (id) {
      const turn = this.turns.find((t) => t.id === id && t.kind === kind);
      if (turn && turn.kind === kind) {
        turn.text = clip(turn.text + chunk, TEXT_CAP);
        return turn;
      }
    }
    const created: Turn = { kind, id: this.nextId(kind), text: clip(chunk, TEXT_CAP) };
    this.open[kind] = created.id;
    this.turns.push(created);
    return created;
  }

  private tool(update: Record<string, unknown>): Turn {
    for (const k of ["user", "assistant", "thought"] as const) this.open[k] = null;
    const id = String(update.toolCallId || this.nextId("tool"));
    const meta = toolMeta(update);
    const turn: Turn = {
      kind: "tool",
      id,
      title: String(update.title || meta.label || meta.name || "Tool"),
      name: meta.name,
      status: String(update.status || "in_progress"),
      input: clip(stringify(update.rawInput), TOOL_CAP),
      output: clip(readOutput(update), TOOL_CAP),
    };
    const existing = this.turns.find((t) => t.kind === "tool" && t.id === id);
    if (existing && existing.kind === "tool") {
      existing.title = turn.title || existing.title;
      existing.name = turn.name || existing.name;
      existing.status = turn.status || existing.status;
      if (turn.input) existing.input = turn.input;
      if (turn.output) existing.output = turn.output;
      return existing;
    }
    this.turns.push(turn);
    return turn;
  }

  private toolUpdate(update: Record<string, unknown>): Turn | null {
    const id = String(update.toolCallId || "");
    const found = id ? this.turns.find((t) => t.kind === "tool" && t.id === id) : undefined;
    if (!found || found.kind !== "tool") return this.tool(update);
    if (update.status) found.status = String(update.status);
    if (update.title) found.title = String(update.title);
    const output = readOutput(update);
    if (output) found.output = clip(output, TOOL_CAP);
    return found;
  }

  private push(turn: Turn): Turn {
    for (const k of ["user", "assistant", "thought"] as const) this.open[k] = null;
    this.turns.push(turn);
    return turn;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}

export function turnsFromJsonl(text: string): Turn[] {
  const builder = new TurnBuilder();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const params = (obj as { params?: unknown }).params;
    if (!params || typeof params !== "object") continue;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== "object") continue;
    builder.apply(update as Record<string, unknown>);
  }
  return builder.turns;
}

export function readText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => readText(part)).join("");
  if (typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content != null) return readText(record.content);
  }
  return "";
}

function readOutput(update: Record<string, unknown>): string {
  const fromContent = readText(update.content);
  if (fromContent.trim()) return fromContent;
  const raw = update.rawOutput ?? update.output;
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const content = record.Content ?? record.content;
    const nested = readText(content);
    if (nested.trim()) return nested;
  }
  return stringify(raw);
}

function toolMeta(update: Record<string, unknown>): { name: string; label: string } {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") return { name: "", label: "" };
  const tool = (meta as { "x.ai/tool"?: unknown })["x.ai/tool"];
  if (!tool || typeof tool !== "object") return { name: "", label: "" };
  const record = tool as { name?: unknown; label?: unknown };
  return { name: String(record.name || ""), label: String(record.label || "") };
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated]`;
}

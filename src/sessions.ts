import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionSummary } from "./protocol.ts";
import { turnsFromJsonl } from "./history.ts";
import type { Turn } from "./protocol.ts";

export function sessionsRoot(): string {
  return process.env.GROK_SESSIONS_ROOT || path.join(os.homedir(), ".grok", "sessions");
}

export function listSessions(limit = 80): SessionSummary[] {
  const root = sessionsRoot();
  const found: SessionSummary[] = [];
  let parents: string[] = [];
  try {
    parents = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const parent of parents) {
    const parentPath = path.join(root, parent);
    let kids: string[] = [];
    try {
      if (!fs.statSync(parentPath).isDirectory()) continue;
      kids = fs.readdirSync(parentPath);
    } catch {
      continue;
    }
    const cwdFromDir = decodeCwd(parent);
    for (const id of kids) {
      if (!isSessionId(id)) continue;
      const dir = path.join(parentPath, id);
      const summaryPath = path.join(dir, "summary.json");
      const updatesPath = path.join(dir, "updates.jsonl");
      let title = "";
      let cwd = cwdFromDir;
      let updatedAt = "";
      let model = "";
      let effort = "";
      try {
        const raw = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
        title = String(raw.generated_title || raw.session_summary || raw.remote_title || "").trim();
        const info = raw.info && typeof raw.info === "object" ? (raw.info as Record<string, unknown>) : {};
        cwd = String(info.cwd || raw.cwd || cwd);
        updatedAt = String(raw.updated_at || raw.last_active_at || raw.created_at || "");
        model = String(raw.current_model_id || "");
        effort = String(raw.reasoning_effort || "");
      } catch {
        /* summary is optional */
      }
      if (!updatedAt) {
        try {
          const stamp = fs.statSync(fs.existsSync(updatesPath) ? updatesPath : dir).mtime.toISOString();
          updatedAt = stamp;
        } catch {
          updatedAt = "";
        }
      }
      if (!title) title = cwd ? path.basename(cwd) : "Session";
      found.push({ id, title, cwd, updatedAt, model, effort, activity: "dormant" });
    }
  }
  found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const seen = new Set<string>();
  const unique: SessionSummary[] = [];
  for (const session of found) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function readHistory(sessionId: string, cwd?: string): Turn[] {
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return [];
  const file = path.join(dir, "updates.jsonl");
  let text = "";
  try {
    const stat = fs.statSync(file);
    const cap = 2_000_000;
    const fh = fs.openSync(file, "r");
    try {
      if (stat.size <= cap) {
        const buf = Buffer.alloc(stat.size);
        fs.readSync(fh, buf, 0, stat.size, 0);
        text = buf.toString("utf8");
      } else {
        const buf = Buffer.alloc(cap);
        fs.readSync(fh, buf, 0, cap, stat.size - cap);
        text = buf.toString("utf8");
        const cut = text.indexOf("\n");
        if (cut >= 0) text = text.slice(cut + 1);
      }
    } finally {
      fs.closeSync(fh);
    }
  } catch {
    return [];
  }
  return turnsFromJsonl(text);
}

export function findSessionDir(sessionId: string, cwd?: string): string | null {
  if (!isSessionId(sessionId)) return null;
  const root = sessionsRoot();
  if (cwd) {
    const direct = path.join(root, encodeURIComponent(path.resolve(cwd)), sessionId);
    if (fs.existsSync(direct)) return direct;
  }
  let parents: string[] = [];
  try {
    parents = fs.readdirSync(root);
  } catch {
    return null;
  }
  const hits: string[] = [];
  for (const parent of parents) {
    const dir = path.join(root, parent, sessionId);
    if (fs.existsSync(path.join(dir, "summary.json")) || fs.existsSync(path.join(dir, "updates.jsonl"))) hits.push(dir);
  }
  if (hits.length === 1) return hits[0];
  if (cwd && hits.length > 1) {
    const wanted = path.resolve(cwd);
    const match = hits.find((dir) => decodeCwd(path.basename(path.dirname(dir))) === wanted);
    if (match) return match;
  }
  return hits[0] || null;
}

function decodeCwd(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) && !id.includes("..");
}

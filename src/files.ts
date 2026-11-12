import fs from "node:fs/promises";
import path from "node:path";

const MAX_READ = 1_000_000;
const MAX_WRITE = 2_000_000;

export async function readTextFile(params: Record<string, unknown>): Promise<{ content: string }> {
  const file = path.resolve(String(params.path || ""));
  if (!file) throw new Error("path required");
  let text = await fs.readFile(file, "utf8");
  const line = params.line != null ? Number(params.line) : null;
  const limit = params.limit != null ? Number(params.limit) : null;
  if (line != null || limit != null) {
    const lines = text.split(/(?<=\n)/);
    const start = line != null && Number.isFinite(line) ? Math.max(0, line - 1) : 0;
    const sliced = lines.slice(start, limit != null && Number.isFinite(limit) ? start + Math.max(0, limit) : undefined);
    text = sliced.join("");
  }
  if (text.length > MAX_READ) text = text.slice(0, MAX_READ);
  return { content: text };
}

export async function writeTextFile(params: Record<string, unknown>): Promise<Record<string, never>> {
  const file = path.resolve(String(params.path || ""));
  if (!params.path) throw new Error("path required");
  const content = String(params.content ?? "");
  if (Buffer.byteLength(content) > MAX_WRITE) throw new Error("content too large");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return {};
}

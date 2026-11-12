import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import type { Hub } from "./hub.ts";

export type HttpOptions = {
  hub: Hub;
  token: string;
  host: string;
  port: number;
  webDir: string;
  phoneUrl: string;
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

export async function startServer(options: HttpOptions): Promise<http.Server> {
  const { hub, token } = options;
  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      await route(req, res, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      sendJson(res, 500, { error: message });
    }
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const onUpgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !authorized(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.addClient(ws));
  };
  const server = http.createServer(onRequest);
  server.on("upgrade", onUpgrade);
  await listen(server, options.port, options.host);
  if (options.host !== "127.0.0.1" && options.host !== "0.0.0.0" && options.host !== "::") {
    const local = http.createServer(onRequest);
    local.on("upgrade", onUpgrade);
    try {
      await listen(local, options.port, "127.0.0.1");
      server.on("close", () => local.close());
    } catch {
      local.close();
    }
  }
  return server;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, options: HttpOptions) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.searchParams.has("k") && req.method === "GET" && !url.pathname.startsWith("/api/")) {
    if (url.searchParams.get("k") !== options.token) {
      sendText(res, 401, "This link is not valid.");
      return;
    }
    url.searchParams.delete("k");
    const location = `${url.pathname}${url.search}` || "/";
    res.writeHead(302, {
      Location: location,
      "Set-Cookie": cookie(options.token),
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!authorized(req, options.token)) {
      sendJson(res, 401, { error: "Open the pairing link from the computer running grok-rc." });
      return;
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      sendJson(res, 200, { sessions: options.hub.sessions() });
      return;
    }
    if (url.pathname === "/api/pair" && req.method === "GET") {
      const qr = await QRCode.toDataURL(options.phoneUrl, { margin: 1, width: 280, color: { dark: "#111111", light: "#ffffff" } });
      sendJson(res, 200, { url: options.phoneUrl, qr });
      return;
    }
    const history = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (history && req.method === "GET") {
      const { readHistory } = await import("./sessions.ts");
      sendJson(res, 200, { turns: readHistory(decodeURIComponent(history[1])) });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (rel.includes("..")) {
    sendText(res, 400, "Bad path");
    return;
  }
  const file = path.join(options.webDir, rel);
  if (!file.startsWith(options.webDir)) {
    sendText(res, 400, "Bad path");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.searchParams.get("k") === token) return true;
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)grc=([^;]+)/);
  return Boolean(match && decodeURIComponent(match[1]) === token);
}

function cookie(token: string): string {
  return `grc=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

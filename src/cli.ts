import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import QRCode from "qrcode";
import { Hub } from "./hub.ts";
import { startServer } from "./http.ts";
import { computerName, lanAddress } from "./net.ts";

type Flags = {
  port: number;
  agentPort: number;
  host: string;
  cwd: string;
  approve: boolean;
  open: boolean;
  help: boolean;
};

const root = projectRoot();

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`grok-rc — remote control for the Grok CLI

Usage:
  grok-rc [--port 8787] [--cwd PATH] [--host 192.168.50.100] [--approve] [--no-open]

The agent keeps running on this computer. The page binds to this Mac's LAN
address so a phone on the same network can open it. --approve answers tool
prompts on this computer.
`);
    return;
  }
  const dataDir = path.join(os.homedir(), ".grok", "grok-rc");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    /* best effort */
  }
  const token = readSecret(path.join(dataDir, "token"));
  const agentSecret = readSecret(path.join(dataDir, "agent-secret"));
  const grokBin = findGrok();
  if (!grokBin) {
    console.error("grok was not found. Install Grok Build, or put the grok binary on PATH.");
    process.exit(1);
  }
  const webDir = await buildWeb();
  const bindHost = flags.host === "auto" ? lanAddress() : flags.host;
  const phoneHost = bindHost === "0.0.0.0" ? lanAddress() : bindHost;
  const phoneUrl = `http://${phoneHost}:${flags.port}/?k=${token}`;
  const localUrl = `http://127.0.0.1:${flags.port}/?k=${token}`;
  const hub = new Hub({
    grokBin,
    cwd: flags.cwd,
    agentPort: flags.agentPort,
    agentSecret,
    approve: flags.approve,
    hostName: computerName(),
    logPath: path.join(dataDir, "agent.log"),
  });
  console.log("Starting the grok agent on this computer…");
  await hub.start();
  const server = await startServer({ hub, token, host: bindHost, port: flags.port, webDir, phoneUrl });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : flags.port;
  console.log("");
  console.log(`Grok RC is listening on ${bindHost}:${port}`);
  console.log(`  This computer   ${localUrl}`);
  if (phoneHost === "127.0.0.1") console.log("  Phone           no LAN address found. Connect this Mac to Wi-Fi, or use the computer link.");
  else console.log(`  Phone           ${phoneUrl}`);
  console.log("");
  if (phoneHost !== "127.0.0.1") {
    console.log(await QRCode.toString(phoneUrl, { type: "terminal", small: true }));
    console.log("Scan the code with the phone camera. The browser is the remote.");
  }
  console.log("Leave this process running. Stop it with Ctrl+C. It does not stop other grok sessions.");
  if (flags.approve) console.log("Tool prompts are approved on this computer (--approve).");
  else console.log("Tool prompts wait for you in the browser.");
  if (flags.open) execFile("open", [localUrl], () => {});

  const shutdown = async () => {
    console.log("\nStopping grok-rc…");
    server.close();
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    port: 8787,
    agentPort: 24719,
    host: "auto",
    cwd: process.cwd(),
    approve: false,
    open: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--approve") flags.approve = true;
    else if (arg === "--no-open") flags.open = false;
    else if (arg === "--port") flags.port = numberArg(argv[++i], "--port");
    else if (arg === "--agent-port") flags.agentPort = numberArg(argv[++i], "--agent-port");
    else if (arg === "--host") flags.host = argv[++i] || flags.host;
    else if (arg === "--cwd") flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else throw new Error(`Unknown argument ${arg}`);
  }
  flags.cwd = path.resolve(flags.cwd);
  if (!fs.existsSync(flags.cwd)) throw new Error(`Folder not found: ${flags.cwd}`);
  return flags;
}

function numberArg(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} needs a port number`);
  return port;
}

function readSecret(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32,}$/i.test(existing)) return existing;
  } catch {
    /* create it */
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const secret = Buffer.from(bytes).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return secret;
}

function findGrok(): string | null {
  const homeBin = path.join(os.homedir(), ".grok", "bin", "grok");
  if (fs.existsSync(homeBin)) return homeBin;
  const parts = (process.env.PATH || "").split(path.delimiter);
  for (const dir of parts) {
    const candidate = path.join(dir, "grok");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function buildWeb(): Promise<string> {
  const out = path.join(root, "dist", "web");
  fs.mkdirSync(out, { recursive: true });
  const web = path.join(root, "src", "web");
  await esbuild.build({
    entryPoints: [path.join(web, "main.ts")],
    bundle: true,
    outfile: path.join(out, "app.js"),
    format: "esm",
    target: "es2022",
    sourcemap: true,
    logLevel: "silent",
  });
  for (const name of ["index.html", "styles.css", "manifest.webmanifest"]) {
    fs.copyFileSync(path.join(web, name), path.join(out, name));
  }
  return out;
}

function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

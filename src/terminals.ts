import { spawn, type ChildProcess } from "node:child_process";

type Term = {
  id: string;
  proc: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  done: Promise<void>;
  resolveDone: () => void;
};

export class Terminals {
  private terms = new Map<string, Term>();
  private seq = 0;

  async create(params: Record<string, unknown>): Promise<{ terminalId: string }> {
    const command = String(params.command || "");
    if (!command) throw new Error("command required");
    const args = Array.isArray(params.args) ? params.args.map((arg) => String(arg)) : [];
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined;
    const limit = Number(params.outputByteLimit) > 0 ? Number(params.outputByteLimit) : 1_048_576;
    const env = { ...process.env };
    if (Array.isArray(params.env)) {
      for (const entry of params.env) {
        if (entry && typeof entry === "object" && "name" in entry) {
          const item = entry as { name?: unknown; value?: unknown };
          env[String(item.name)] = String(item.value ?? "");
        }
      }
    }
    const proc = args.length
      ? spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    this.seq += 1;
    const id = `t${this.seq}`;
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const term: Term = {
      id,
      proc,
      chunks: [],
      bytes: 0,
      limit,
      truncated: false,
      exitCode: null,
      signal: null,
      done,
      resolveDone,
    };
    const push = (chunk: Buffer) => this.push(term, chunk);
    proc.stdout?.on("data", push);
    proc.stderr?.on("data", push);
    proc.on("close", (code, signal) => {
      term.exitCode = code;
      term.signal = signal;
      term.resolveDone();
    });
    proc.on("error", (error) => {
      this.push(term, Buffer.from(`\n${error.message}\n`));
      term.exitCode = term.exitCode ?? 1;
      term.resolveDone();
    });
    this.terms.set(id, term);
    return { terminalId: id };
  }

  output(params: Record<string, unknown>) {
    const term = this.must(params);
    return {
      output: Buffer.concat(term.chunks).toString("utf8"),
      truncated: term.truncated,
      exitStatus:
        term.exitCode == null && !term.signal
          ? null
          : { exitCode: term.exitCode, signal: term.signal },
    };
  }

  async wait(params: Record<string, unknown>) {
    const term = this.must(params);
    await term.done;
    return this.output(params);
  }

  async kill(params: Record<string, unknown>) {
    const term = this.must(params);
    if (term.exitCode == null) term.proc.kill("SIGTERM");
    await Promise.race([term.done, sleep(1500)]);
    if (term.exitCode == null) term.proc.kill("SIGKILL");
    return {};
  }

  async release(params: Record<string, unknown>) {
    const id = String(params.terminalId || "");
    const term = this.terms.get(id);
    if (!term) return {};
    this.terms.delete(id);
    if (term.exitCode == null) term.proc.kill("SIGTERM");
    return {};
  }

  async shutdown() {
    for (const term of this.terms.values()) {
      if (term.exitCode == null) term.proc.kill("SIGTERM");
    }
    this.terms.clear();
  }

  private must(params: Record<string, unknown>): Term {
    const term = this.terms.get(String(params.terminalId || ""));
    if (!term) throw new Error("unknown terminal");
    return term;
  }

  private push(term: Term, chunk: Buffer) {
    if (term.truncated) return;
    if (term.bytes + chunk.length > term.limit) {
      const room = Math.max(0, term.limit - term.bytes);
      if (room) term.chunks.push(chunk.subarray(0, room));
      term.bytes = term.limit;
      term.truncated = true;
      return;
    }
    term.chunks.push(chunk);
    term.bytes += chunk.length;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

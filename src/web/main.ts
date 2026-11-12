import { TurnBuilder } from "../history.ts";
import type { ClientMsg, ImageBlock, PermissionOption, ServerMsg, SessionSummary, Turn } from "../protocol.ts";

const demo = new URLSearchParams(location.search).get("demo") === "1";
const app = document.querySelector<HTMLDivElement>("#app")!;
const lock = document.querySelector<HTMLDivElement>("#lock")!;
const listEl = document.querySelector<HTMLDivElement>("#sessionList")!;
const feed = document.querySelector<HTMLDivElement>("#feed")!;
const queueEl = document.querySelector<HTMLDivElement>("#queue")!;
const titleEl = document.querySelector<HTMLHeadingElement>("#title")!;
const subtitle = document.querySelector<HTMLParagraphElement>("#subtitle")!;
const box = document.querySelector<HTMLTextAreaElement>("#box")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const filesEl = document.querySelector<HTMLDivElement>("#files")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stopBtn")!;
const hostLine = document.querySelector<HTMLParagraphElement>("#hostLine")!;
const linkState = document.querySelector<HTMLSpanElement>("#linkState")!;
const sheet = document.querySelector<HTMLDivElement>("#sheet")!;
const perm = document.querySelector<HTMLDivElement>("#perm")!;
const toast = document.querySelector<HTMLDivElement>("#toast")!;

const state: {
  host: string;
  cwd: string;
  approve: boolean;
  online: boolean;
  sessions: SessionSummary[];
  active: string;
  running: boolean;
  label: string;
  queue: { clientId: string; text: string }[];
  images: ImageBlock[];
  builders: Map<string, TurnBuilder>;
  arm: string;
  buffer: Record<string, unknown>[];
  perms: Map<string, Extract<ServerMsg, { type: "permission" }>>;
  localEcho: string;
} = {
  host: "",
  cwd: "",
  approve: false,
  online: false,
  sessions: [],
  active: "",
  running: false,
  label: "",
  queue: [],
  images: [],
  builders: new Map(),
  arm: "",
  buffer: [],
  perms: new Map(),
  localEcho: "",
};

let socket: WebSocket | null = null;
let stick = true;

document.querySelector<HTMLButtonElement>("#newBtn")!.addEventListener("click", () => openNew());
document.querySelector<HTMLButtonElement>("#newMobile")!.addEventListener("click", () => openNew());
document.querySelector("#backBtn")!.addEventListener("click", () => setMode("list"));
document.querySelector("#pairBtn")!.addEventListener("click", () => void openPair());
document.querySelector("#composer")!.addEventListener("submit", (event) => {
  event.preventDefault();
  send();
});
stopBtn.addEventListener("click", () => {
  if (state.active) sendMsg({ type: "cancel", sessionId: state.active });
});
box.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(max-width: 860px)").matches) {
    event.preventDefault();
    send();
  }
});
box.addEventListener("input", growBox);
fileInput.addEventListener("change", () => void takeFiles(fileInput.files));
feed.addEventListener("scroll", () => {
  stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
});
window.visualViewport?.addEventListener("resize", syncKeyboard);
window.visualViewport?.addEventListener("scroll", syncKeyboard);
syncKeyboard();

if (demo) bootDemo();
else connect();

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    setLink(true);
    if (state.active) sendMsg({ type: "subscribe", sessionId: state.active });
  });
  socket.addEventListener("close", () => {
    setLink(false);
    window.setTimeout(connect, 1200);
  });
  socket.addEventListener("message", (event) => onServer(JSON.parse(String(event.data)) as ServerMsg));
}

function onServer(message: ServerMsg) {
  if (message.type === "hello") {
    lock.hidden = true;
    app.hidden = false;
    state.host = message.host;
    state.cwd = message.cwd;
    state.approve = message.approve;
    state.sessions = message.sessions;
    hostLine.textContent = message.host;
    renderSessions();
    return;
  }
  if (message.type === "agent") {
    state.online = message.online;
    setLink(message.online);
    return;
  }
  if (message.type === "sessions") {
    state.sessions = message.sessions;
    renderSessions();
    paintHeader();
    return;
  }
  if (message.type === "created") {
    state.active = message.sessionId;
    state.arm = message.sessionId;
    state.buffer = [];
    ensureBuilder(message.sessionId).reset([]);
    keepLocalEcho(message.sessionId);
    setMode("chat");
    paintHeader();
    renderFeed();
    return;
  }
  if (message.type === "history") {
    const builder = ensureBuilder(message.sessionId);
    builder.reset(message.turns);
    if (state.arm === message.sessionId) {
      for (const update of state.buffer) builder.apply(update);
      state.buffer = [];
      state.arm = "";
    }
    if (message.sessionId === state.active) {
      keepLocalEcho(message.sessionId);
      renderFeed();
    }
    return;
  }
  if (message.type === "update") {
    const kind = String(message.update.sessionUpdate || "");
    if (kind === "user_message_chunk" && state.localEcho && message.sessionId === state.active) return;
    if (state.arm === message.sessionId) state.buffer.push(message.update);
    else if (!ensureBuilder(message.sessionId).apply(message.update)) return;
    if (message.sessionId === state.active) renderFeed();
    return;
  }
  if (message.type === "status") {
    if (message.sessionId !== state.active) return;
    state.running = message.running;
    state.label = message.label;
    stopBtn.hidden = !message.running;
    paintHeader();
    renderFeed();
    return;
  }
  if (message.type === "queue" && message.sessionId === state.active) {
    state.queue = message.items;
    renderQueue();
    return;
  }
  if (message.type === "permission") {
    state.perms.set(message.requestId, message);
    renderPerm();
    return;
  }
  if (message.type === "permission_closed") {
    state.perms.delete(message.requestId);
    renderPerm();
    return;
  }
  if (message.type === "error") showToast(message.message);
  if (message.type === "prompt_done" && message.sessionId === state.active) {
    state.running = false;
    state.label = "";
    state.localEcho = "";
    stopBtn.hidden = true;
    paintHeader();
    renderFeed();
  }
}

function send() {
  const text = box.value.trim();
  const images = state.images;
  if (!text && images.length === 0) return;
  if (!state.active) {
    openNew(text);
    return;
  }
  if (!canSend()) return;
  const clientId = `c${Date.now()}`;
  noteSent(state.active, text || (images.length ? "Photo" : ""));
  sendMsg({ type: "prompt", sessionId: state.active, text, images, clientId });
  box.value = "";
  state.images = [];
  renderFiles();
  growBox();
}

function openSession(session: SessionSummary) {
  state.active = session.id;
  state.arm = session.id;
  state.buffer = [];
  state.running = session.activity === "running";
  state.localEcho = "";
  state.queue = [];
  setMode("chat");
  paintHeader();
  feed.replaceChildren();
  renderQueue();
  sendMsg({ type: "subscribe", sessionId: session.id });
  renderSessions();
}

function openNew(preset = "") {
  const text = typeof preset === "string" ? preset : "";
  sheet.hidden = false;
  sheet.replaceChildren();
  const dialog = document.createElement("form");
  dialog.className = "dialog";
  dialog.innerHTML = `
    <p class="mark">New task</p>
    <h1>Start on this computer</h1>
    <label>Folder<input name="cwd" value="${escapeAttr(state.cwd || "")}" autocomplete="off" /></label>
    <label>First message<textarea name="text" rows="4" placeholder="What should it do?"></textarea></label>
    <div class="row"><button class="btn ghost" type="button" id="cancelNew">Cancel</button><button class="btn primary" type="submit">Start</button></div>`;
  sheet.append(dialog);
  const area = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  if (text) area.value = text;
  dialog.querySelector("#cancelNew")!.addEventListener("click", closeSheet);
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(dialog);
    const cwd = String(data.get("cwd") || state.cwd);
    const first = String(data.get("text") || "").trim();
    if (!canSend()) return;
    state.localEcho = first || (state.images.length ? "Photo" : "");
    state.running = true;
    state.label = "Starting";
    state.active = "";
    setMode("chat");
    paintHeader();
    renderFeed();
    sendMsg({ type: "new", cwd, text: first, images: state.images, clientId: `c${Date.now()}` });
    state.images = [];
    renderFiles();
    box.value = "";
    closeSheet();
  });
}

async function openPair() {
  sheet.hidden = false;
  sheet.innerHTML = `<form class="dialog"><p class="mark">Phone</p><h1>Same Wi-Fi, no install</h1><p>Scan this with the phone camera. It opens the remote in the browser.</p><div class="pair-url">Loading…</div><div class="row"><button class="btn ghost" type="button" id="closePair">Close</button></div></form>`;
  sheet.querySelector("#closePair")!.addEventListener("click", closeSheet);
  try {
    const response = await fetch("/api/pair");
    if (!response.ok) throw new Error("The pairing link needs the computer session.");
    const body = (await response.json()) as { url: string; qr: string };
    const url = sheet.querySelector(".pair-url")!;
    url.textContent = body.url;
    const image = document.createElement("img");
    image.className = "pair-qr";
    image.alt = "Pairing code";
    image.src = body.qr;
    url.before(image);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not load the code");
  }
}

function renderSessions() {
  listEl.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No sessions yet. Start a new task.";
    listEl.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `session${session.id === state.active ? " active" : ""}`;
    button.type = "button";
    const dot = document.createElement("span");
    dot.className = `dot${session.activity === "running" ? " live" : ""}`;
    const text = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = session.title || "Session";
    name.title = session.title || "Session";
    const path = document.createElement("small");
    path.textContent = shortPath(session.cwd);
    path.title = session.cwd;
    text.append(name, path);
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ago(session.updatedAt);
    button.append(dot, text, when);
    button.addEventListener("click", () => openSession(session));
    listEl.append(button);
  }
}

function renderFeed() {
  const turns = ensureBuilder(state.active).turns;
  const atBottom = stick;
  feed.replaceChildren();
  if (!state.active) {
    if (state.running) feed.append(pendingRow());
    else {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Pick a session or start a new task. The work happens on your computer.";
      feed.append(empty);
    }
    return;
  }
  if (!turns.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "This session is ready. Send a message from here.";
    feed.append(empty);
  }
  for (const turn of turns) feed.append(renderTurn(turn));
  if (state.running) feed.append(pendingRow());
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function renderTurn(turn: Turn): HTMLElement {
  const article = document.createElement("article");
  article.className = `turn ${turn.kind}`;
  article.dataset.id = turn.id;
  if (turn.kind === "user") {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = turn.text;
    article.append(bubble);
  } else if (turn.kind === "assistant") {
    const bubble = document.createElement("div");
    bubble.className = "bubble md";
    bubble.innerHTML = markdown(turn.text);
    article.append(bubble);
  } else if (turn.kind === "thought") {
    const details = document.createElement("details");
    details.className = "thought";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const body = document.createElement("div");
    body.textContent = turn.text;
    details.append(summary, body);
    article.append(details);
  } else if (turn.kind === "tool") {
    const details = document.createElement("details");
    details.className = "tool";
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.textContent = turn.title || turn.name || "Tool";
    const status = document.createElement("span");
    status.className = `status-pill${turn.status === "completed" ? " done" : turn.status === "failed" ? " bad" : ""}`;
    status.textContent = statusLabel(turn.status);
    summary.append(name, status);
    details.append(summary);
    if (turn.input) details.append(pre(turn.input));
    if (turn.output) details.append(pre(turn.output));
    article.append(details);
  } else {
    const line = document.createElement("div");
    line.className = "system";
    line.textContent = turn.text;
    article.append(line);
  }
  return article;
}

function renderQueue() {
  queueEl.replaceChildren();
  for (const item of state.queue) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item.text.slice(0, 80) || "Queued";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => sendMsg({ type: "drop", sessionId: state.active, clientId: item.clientId }));
    chip.append(remove);
    queueEl.append(chip);
  }
}

function renderPerm() {
  const next = state.perms.values().next().value as Extract<ServerMsg, { type: "permission" }> | undefined;
  if (!next) {
    perm.hidden = true;
    perm.replaceChildren();
    return;
  }
  perm.hidden = false;
  perm.replaceChildren();
  const card = document.createElement("div");
  card.className = "dialog perm-card";
  const kicker = document.createElement("p");
  kicker.className = "mark";
  kicker.textContent = "Approval";
  const heading = document.createElement("h1");
  heading.textContent = next.title || "Allow this action?";
  card.append(kicker, heading);
  if (next.input) card.append(pre(next.input));
  const actions = document.createElement("div");
  actions.className = "perm-actions";
  for (const option of next.options) actions.append(optionButton(next.requestId, option));
  card.append(actions);
  perm.append(card);
}

function optionButton(requestId: string, option: PermissionOption): HTMLButtonElement {
  const button = document.createElement("button");
  const risky = /always/i.test(`${option.kind} ${option.id} ${option.name}`);
  const deny = /reject|deny|cancel/i.test(`${option.kind} ${option.id} ${option.name}`);
  button.type = "button";
  button.className = `btn ${deny ? "ghost" : "primary"}${risky ? " hold" : ""}`;
  button.textContent = option.name;
  if (!risky) {
    button.addEventListener("click", () => sendMsg({ type: "permission", requestId, optionId: option.id }));
    return button;
  }
  const fill = document.createElement("i");
  button.append(fill);
  let timer = 0;
  const start = (event: PointerEvent) => {
    button.setPointerCapture(event.pointerId);
    fill.style.width = "0";
    const began = performance.now();
    const step = (now: number) => {
      const pct = Math.min(1, (now - began) / 650);
      fill.style.width = `${pct * 100}%`;
      if (pct >= 1) {
        sendMsg({ type: "permission", requestId, optionId: option.id });
        return;
      }
      timer = requestAnimationFrame(step);
    };
    timer = requestAnimationFrame(step);
  };
  const cancel = () => {
    cancelAnimationFrame(timer);
    fill.style.width = "0";
  };
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", cancel);
  button.addEventListener("pointerleave", cancel);
  button.addEventListener("pointercancel", cancel);
  return button;
}

function renderFiles() {
  filesEl.replaceChildren();
  for (const image of state.images) {
    const img = document.createElement("img");
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.alt = "";
    filesEl.append(img);
  }
}

function noteSent(sessionId: string, text: string) {
  state.running = true;
  state.label = "Working";
  state.localEcho = text;
  stick = true;
  if (text) {
    const builder = ensureBuilder(sessionId);
    builder.break();
    builder.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  }
  renderFeed();
  paintHeader();
}

function keepLocalEcho(sessionId: string) {
  const text = state.localEcho;
  if (!text || state.active !== sessionId) return;
  const turns = ensureBuilder(sessionId).turns;
  const lastUser = [...turns].reverse().find((turn) => turn.kind === "user");
  if (lastUser && "text" in lastUser && lastUser.text === text) return;
  const builder = ensureBuilder(sessionId);
  builder.break();
  builder.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
}

function pendingRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "pending";
  const dot = document.createElement("i");
  const label = document.createElement("span");
  label.textContent = state.label || "Working";
  row.append(dot, label);
  return row;
}

function canSend(): boolean {
  if (demo || (socket && socket.readyState === WebSocket.OPEN)) return true;
  showToast("Not connected to the computer yet");
  return false;
}

function paintHeader() {
  const session = state.sessions.find((item) => item.id === state.active);
  titleEl.textContent = session?.title || (state.active || state.running ? "New task" : "Select a session");
  const bits = [session?.cwd ? shortPath(session.cwd) : "", state.label && state.running ? state.label : "", session?.model || ""].filter(Boolean);
  subtitle.textContent = bits.join(" · ");
  stopBtn.hidden = !state.running;
}

function setMode(mode: "list" | "chat") {
  app.classList.toggle("mode-list", mode === "list");
  app.classList.toggle("mode-chat", mode === "chat");
}

function setLink(online: boolean) {
  linkState.textContent = online ? "Computer online" : "Reconnecting";
}

function ensureBuilder(id: string): TurnBuilder {
  let builder = state.builders.get(id);
  if (!builder) {
    builder = new TurnBuilder();
    state.builders.set(id, builder);
  }
  return builder;
}

function sendMsg(message: ClientMsg) {
  if (demo) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Not connected to the computer yet");
    return;
  }
  socket.send(JSON.stringify(message));
}

async function takeFiles(list: FileList | null) {
  if (!list) return;
  for (const file of Array.from(list).slice(0, 4 - state.images.length)) {
    if (!file.type.startsWith("image/")) continue;
    const data = await readBase64(file);
    if (data.length > 4_500_000) {
      showToast("That photo is too large");
      continue;
    }
    state.images.push({ mimeType: file.type, data });
  }
  fileInput.value = "";
  renderFiles();
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function closeSheet() {
  sheet.hidden = true;
  sheet.replaceChildren();
}

function showToast(text: string) {
  toast.hidden = false;
  toast.textContent = text;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function growBox() {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, Math.round(window.innerHeight * 0.3))}px`;
}

function syncKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  document.documentElement.style.setProperty("--kb", `${overlap}px`);
}

function shortPath(cwd: string): string {
  const home = cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  return home;
}

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const minutes = Math.max(0, Date.now() - then) / 60000;
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function statusLabel(status: string): string {
  if (!status || status === "in_progress" || status === "pending") return "Running";
  if (status === "completed" || status === "done") return "Done";
  if (status === "failed" || status === "error") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return status.replaceAll("_", " ");
}

function pre(text: string): HTMLElement {
  const node = document.createElement("pre");
  node.textContent = text;
  return node;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function markdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("```")) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      html.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }
    const item = lines[i].match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();
    if (!lines[i].trim()) flushParagraph();
    else paragraph.push(lines[i]);
  }
  flushParagraph();
  flushList();
  return html.join("");
}

function inline(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bootDemo() {
  lock.hidden = true;
  app.hidden = false;
  state.host = "studio";
  state.cwd = "/Users/ada/src/app";
  state.online = true;
  state.sessions = [
    {
      id: "demo-1",
      title: "Ship the phone layout",
      cwd: "/Users/ada/src/app",
      updatedAt: new Date().toISOString(),
      model: "grok-4.7",
      effort: "medium",
      activity: "running",
    },
    {
      id: "demo-2",
      title: "Read the session index",
      cwd: "/Users/ada/src/notes",
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      model: "grok-4.7",
      effort: "low",
      activity: "dormant",
    },
  ];
  hostLine.textContent = "studio";
  linkState.textContent = "Demo";
  const builder = ensureBuilder("demo-1");
  builder.reset([
    { kind: "user", id: "u1", text: "Make the mobile layout a session list, then a chat." },
    { kind: "thought", id: "t1", text: "The phone should not inherit the desktop grid." },
    { kind: "assistant", id: "a1", text: "The phone opens on the session list. A task fills the screen, with the composer sitting above the keyboard." },
    {
      kind: "tool",
      id: "tool-1",
      title: "bash",
      name: "bash",
      status: "in_progress",
      input: "npm test",
      output: "",
    },
  ]);
  renderSessions();
  openSession(state.sessions[0]);
  state.running = true;
  state.label = "bash";
  stopBtn.hidden = false;
  paintHeader();
  renderFeed();
  if (new URLSearchParams(location.search).get("sheet") === "permission") {
    state.perms.set("1", {
      type: "permission",
      requestId: "1",
      sessionId: "demo-1",
      title: "bash",
      kind: "execute",
      input: "npm test",
      options: [
        { id: "allow-once", name: "Allow once", kind: "allow_once" },
        { id: "allow-always", name: "Always allow", kind: "allow_always" },
        { id: "reject", name: "Deny", kind: "reject_once" },
      ],
    });
    renderPerm();
  }
  if (new URLSearchParams(location.search).get("view") === "list") setMode("list");
}

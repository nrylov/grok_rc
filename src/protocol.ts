export type ImageBlock = { mimeType: string; data: string };

export type Turn =
  | { kind: "user" | "assistant" | "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      name: string;
      status: string;
      input: string;
      output: string;
    }
  | { kind: "system"; id: string; text: string };

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  model: string;
  effort: string;
  activity: string;
};

export type PermissionOption = { id: string; name: string; kind: string };

export type ClientMsg =
  | { type: "subscribe"; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string; images?: ImageBlock[]; clientId?: string }
  | { type: "new"; cwd: string; text?: string; images?: ImageBlock[]; clientId?: string }
  | { type: "cancel"; sessionId: string }
  | { type: "drop"; sessionId: string; clientId: string }
  | { type: "permission"; requestId: string; optionId: string }
  | { type: "refresh" };

export type ServerMsg =
  | { type: "hello"; host: string; cwd: string; approve: boolean; sessions: SessionSummary[] }
  | { type: "created"; sessionId: string; cwd: string }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "history"; sessionId: string; turns: Turn[] }
  | { type: "update"; sessionId: string; update: Record<string, unknown> }
  | { type: "status"; sessionId: string; running: boolean; label: string }
  | { type: "queued"; sessionId: string; clientId: string; text: string }
  | { type: "queue"; sessionId: string; items: { clientId: string; text: string }[] }
  | {
      type: "permission";
      requestId: string;
      sessionId: string;
      title: string;
      kind: string;
      input: string;
      options: PermissionOption[];
    }
  | { type: "permission_closed"; requestId: string }
  | { type: "prompt_done"; sessionId: string; stopReason: string }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "agent"; online: boolean };

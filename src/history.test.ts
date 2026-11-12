import assert from "node:assert/strict";
import test from "node:test";
import { TurnBuilder, turnsFromJsonl } from "./history.ts";

test("coalesces adjacent chunks and keeps tool updates", () => {
  const builder = new TurnBuilder();
  builder.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } });
  builder.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } });
  builder.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "…" } });
  builder.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
  builder.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } });
  builder.apply({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "list_dir",
    rawInput: { target_directory: "/tmp" },
  });
  builder.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    rawOutput: { Content: { content: "a.txt\n" } },
  });

  assert.equal(builder.turns.length, 4);
  assert.deepEqual(
    builder.turns.map((turn) => turn.kind),
    ["user", "thought", "assistant", "tool"],
  );
  builder.break();
  builder.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Next" } });
  assert.equal(builder.turns.filter((turn) => turn.kind === "user").length, 2);
  assert.equal(builder.turns[1] && "text" in builder.turns[1] ? builder.turns[1].text : "", "Hmm…");
  assert.equal(builder.turns[2] && "text" in builder.turns[2] ? builder.turns[2].text : "", "Hi there");
  const tool = builder.turns[3];
  assert.equal(tool && tool.kind, "tool");
  if (tool && tool.kind === "tool") {
    assert.equal(tool.status, "completed");
    assert.equal(tool.output, "a.txt\n");
    assert.match(tool.input, /\/tmp/);
  }
});

test("parses jsonl session updates", () => {
  const line = JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "abc",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Ping" } },
    },
  });
  const turns = turnsFromJsonl(`${line}\nnot json\n`);
  assert.equal(turns.length, 1);
  assert.equal(turns[0] && "text" in turns[0] ? turns[0].text : "", "Ping");
});

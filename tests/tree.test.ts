// The tree picker as rules: what each entry kind shows as a row, and the wiring over a fake TUI —
// newest first and selected, enter picking, escape leaving, a query narrowing.

import { homedir } from "node:os";
import type { AssistantMessage, JsonObject, Message, Usage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { row, searchText, treePicker } from "../src/tree.ts";

/** All FilterList asks of the TUI: render requests that go nowhere. */
const tui = { requestRender: () => undefined } as unknown as TUI;

function entry(id: number, kind: string, model?: readonly Message[]): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    model,
  };
}

const user = (id: number, text: string): EntryRecord =>
  entry(id, "pi.user", [{ role: "user", content: text, timestamp: 0 }]);

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answer(id: number, content: AssistantMessage["content"], model = "faux-1"): EntryRecord {
  return entry(id, "pi.assistant", [
    {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "faux",
      model,
      usage,
      stopReason: "stop",
      timestamp: 0,
    },
  ]);
}

function call(id: number, name: string, args: JsonObject): EntryRecord {
  return answer(id, [{ type: "toolCall", id: "c1", name, arguments: args }]);
}

function result(id: number, name: string, text: string, isError = false): EntryRecord {
  return entry(id, "pi.tool-result", [
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: name,
      content: [{ type: "text", text }],
      isError,
      timestamp: 0,
    },
  ]);
}

describe("row", () => {
  it("previews user text as one line", () => {
    expect(row(user(1, "fix the\n   flaky\n\nlogin flow"))).toEqual({
      label: "user · fix the flaky login flow",
    });
  });

  it("previews assistant text with the answering model beside it", () => {
    expect(row(answer(2, [{ type: "text", text: "I'll rerun it." }]))).toEqual({
      label: "assistant · I'll rerun it.",
      description: "faux/faux-1",
    });
  });

  it("names a call by the argument that identifies it, home shortened", () => {
    expect(row(call(3, "bash", { command: "pnpm\n  test" }))).toEqual({
      label: "tool call · bash pnpm test",
      description: "faux/faux-1",
    });
    expect(row(call(4, "read", { path: `${homedir()}/key/src/tree.ts` })).label).toBe(
      "tool call · read ~/key/src/tree.ts",
    );
    expect(row(call(5, "wait", {})).label).toBe("tool call · wait");
  });

  it("carries a tool result's output beside its name, errors marked in the name", () => {
    expect(row(result(6, "bash", "3 passed,\n1 failed"))).toEqual({
      label: "tool result · bash",
      description: "3 passed, 1 failed",
    });
    expect(row(result(7, "bash", "no such file", true))).toEqual({
      label: "tool result · bash (error)",
      description: "no such file",
    });
  });

  it("labels compaction by its summary and reset by its handoff", () => {
    const summary = entry(8, "pi.compaction", [
      { role: "user", content: "Earlier: the login work.", timestamp: 0 },
    ]);
    expect(row(summary)).toEqual({ label: "compaction · Earlier: the login work." });
    expect(row(entry(9, "pi.reset"))).toEqual({ label: "reset" });
    const handoff = entry(10, "pi.reset", [
      { role: "user", content: "Take over the task.", timestamp: 0 },
    ]);
    expect(row(handoff).label).toBe("reset · Take over the task.");
  });

  it("falls back to bare kind words for system, empty, model-less, and unknown entries", () => {
    const system = entry(11, "pi.system", [{ role: "system", content: "", timestamp: 0 }]);
    expect(row(system)).toEqual({ label: "system" });
    expect(row(entry(12, "pi.assistant"))).toEqual({ label: "assistant" });
    expect(row(answer(13, [], ""))).toEqual({ label: "assistant" });
    expect(row(entry(14, "key.note"))).toEqual({ label: "key.note" });
    const note = entry(15, "key.note", [{ role: "user", content: "a placed note", timestamp: 0 }]);
    expect(row(note).label).toBe("key.note · a placed note");
  });
});

describe("searchText", () => {
  it("exposes everything the row shows: kind, text, tool name, output, model", () => {
    expect(searchText(result(20, "web_search", "node 24 is out"))).toBe(
      "tool result · web_search node 24 is out",
    );
    expect(searchText(answer(21, [{ type: "text", text: "Done." }]))).toBe(
      "assistant · Done. faux/faux-1",
    );
  });
});

describe("treePicker", () => {
  it("opens on the newest entry: enter picks it, escape cancels", () => {
    const picked: EntryRecord[] = [];
    let canceled = false;
    const list = treePicker(
      tui,
      [user(1, "first"), answer(2, [{ type: "text", text: "working on it" }]), user(3, "last")],
      (chosen) => picked.push(chosen),
      () => {
        canceled = true;
      },
    );
    list.handleInput("\r"); // enter
    expect(picked.map((chosen) => chosen.id)).toEqual([3]);
    list.handleInput("\x1b"); // escape
    expect(canceled).toBe(true);
  });

  it("orders newest first: down then enter picks the second newest", () => {
    const picked: EntryRecord[] = [];
    const list = treePicker(
      tui,
      [user(1, "a"), user(2, "b"), user(3, "c")],
      (chosen) => picked.push(chosen),
      () => undefined,
    );
    list.handleInput("\x1b[B"); // down
    list.handleInput("\r"); // enter
    expect(picked.map((chosen) => chosen.id)).toEqual([2]);
  });

  it("narrows to the rows the query names", () => {
    const picked: EntryRecord[] = [];
    const list = treePicker(
      tui,
      [
        user(1, "fix login"),
        entry(2, "pi.compaction", [
          { role: "user", content: "Earlier: the login work.", timestamp: 0 },
        ]),
        result(3, "bash", "login tests pass"),
      ],
      (chosen) => picked.push(chosen),
      () => undefined,
    );
    for (const letter of "compaction") list.handleInput(letter);
    list.handleInput("\r"); // enter
    expect(picked.map((chosen) => chosen.kind)).toEqual(["pi.compaction"]);
  });
});

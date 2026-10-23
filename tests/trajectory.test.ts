// The transcript as a reader sees it: every case here builds a view by hand and reads the rendered
// lines back with color stripped, so a rule is pinned as text rather than as ANSI.

import type { AssistantMessage, JsonObject, Message, Usage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { transcript } from "../src/trajectory.ts";

const WIDTH = 80;

function view(entries: readonly EntryRecord[], live?: LiveState): ConversationView {
  return {
    conversation: {} as ConversationView["conversation"],
    entries,
    docs: live ? { "pi.live": live } : {},
  };
}

let nextId = 0;

function entry(kind: string, model?: readonly Message[]): EntryRecord {
  nextId += 1;
  return {
    id: nextId as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    model,
  };
}

function user(text: string): EntryRecord {
  return entry("pi.user", [{ role: "user", content: text, timestamp: 0 }]);
}

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answer(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
) {
  return entry("pi.assistant", [
    {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openai",
      model: "gpt",
      usage,
      stopReason,
      timestamp: 0,
    },
  ]);
}

function call(id: string, name: string, args: JsonObject): EntryRecord {
  return answer([{ type: "toolCall", id, name, arguments: args }], "toolUse");
}

function result(
  id: string,
  name: string,
  text: string,
  options: { readonly details?: JsonObject; readonly isError?: boolean } = {},
): EntryRecord {
  return entry("pi.tool-result", [
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError: options.isError ?? false,
      timestamp: 0,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  ]);
}

/** Every line the reader sees, each with its trailing padding removed. */
function lines(conversation: ConversationView): string[] {
  return transcript(conversation)
    .flatMap((block) => block.render(WIDTH))
    .map((line) => stripTerminalSequences(line).trimEnd());
}

function text(conversation: ConversationView): string {
  return lines(conversation).join("\n");
}

describe("transcript", () => {
  it("a user message renders as a box with its text", () => {
    const rows = lines(view([user("fix the failing test")]));
    expect(rows.some((row) => row.includes("fix the failing test"))).toBe(true);
    expect(rows.some((row) => row.trim() === "")).toBe(true);
  });

  it("assistant text renders as markdown and thinking renders above it", () => {
    const rendered = text(
      view([
        answer([
          { type: "thinking", thinking: "The test is flaky." },
          { type: "text", text: "The **fix** is to await the promise." },
        ]),
      ]),
    );
    const thinking = rendered.indexOf("The test is flaky.");
    const reply = rendered.indexOf("The fix is to await the promise.");
    expect(thinking).toBeGreaterThanOrEqual(0);
    expect(reply).toBeGreaterThan(thinking);
  });

  it("a settled tool call shows its title and hides all but the last lines", () => {
    const rows = lines(
      view([
        call("c1", "bash", { command: "pnpm test" }),
        result("c1", "bash", "1\n2\n3\n4\n5\n6\n7"),
      ]),
    ).map((row) => row.trim());
    expect(rows).toContain("bash pnpm test");
    expect(rows).toContain("... (2 earlier lines)");
    expect(rows).not.toContain("1");
    expect(rows).not.toContain("2");
    expect(
      rows.filter((row) => row === "3" || row === "4" || row === "5" || row === "6" || row === "7"),
    ).toHaveLength(5);
  });

  it("a tool call is titled by its identifying argument", () => {
    const titled = (args: JsonObject): string =>
      text(view([call("c1", "tool", args), result("c1", "tool", "ok")]));
    expect(titled({ command: "ls -la", path: "/tmp", pattern: "x" })).toContain("tool ls -la");
    expect(titled({ path: "/tmp", pattern: "x", query: "fallback" })).toContain("tool /tmp");
    expect(titled({ pattern: "TODO", query: "fallback" })).toContain("tool TODO");
    expect(titled({ query: "fallback" })).toContain("tool fallback");
  });

  it("an edit renders its diff with +/- lines", () => {
    const rendered = text(
      view([
        call("c1", "edit", { path: "src/a.ts" }),
        result("c1", "edit", "ok", {
          details: { diff: " 1 const a = 1;\n-2 const b = 2;\n+2 const b = 3;" },
        }),
      ]),
    );
    expect(rendered).toContain("-2 const b = 2;");
    expect(rendered).toContain("+2 const b = 3;");
    expect(rendered).toContain(" 1 const a = 1;");
  });

  it("a call with no result yet keeps its running box, with the command it runs", () => {
    const running = text(
      view([call("c1", "bash", { command: "pnpm test" })], {
        generation: { attempt: 1 },
        tools: [{ callId: "c1", name: "bash", status: "running" }],
      }),
    );
    expect(running).toContain("bash pnpm test");
    expect(running).not.toContain("empty transcript");
  });

  it("thinking still being written shows while the generation runs", () => {
    const live = view([user("fix it")], {
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Reading the failing test first." }],
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-flash",
          usage,
          stopReason: "stop",
          timestamp: 0,
        },
      },
    });
    const rendered = text(live);
    expect(rendered).toContain("Reading the failing test first.");
    expect(rendered).not.toContain("empty transcript");
  });

  it("a call whose result landed shows its title once, with the output beneath", () => {
    const rows = lines(
      view([call("c1", "bash", { command: "pnpm test" }), result("c1", "bash", "ok")]),
    ).map((row) => row.trim());
    expect(rows.filter((row) => row === "bash pnpm test")).toHaveLength(1);
    expect(rows).toContain("ok");
  });

  it("a failed, aborted, or truncated answer says so", () => {
    const failure = (stopReason: AssistantMessage["stopReason"]): string =>
      text(view([answer([{ type: "text", text: "partial answer" }], stopReason)]));
    expect(failure("error")).toContain("Error: Unknown error");
    expect(failure("aborted")).toContain("Operation aborted");
    expect(failure("length")).toContain("Response was truncated before completion.");
    expect(failure("stop")).not.toContain("Error");
    expect(failure("toolUse")).not.toMatch(/aborted|truncated|Error/);
  });

  it("an aborted answer says so, even with nothing to show", () => {
    expect(text(view([answer([], "aborted")]))).toContain("Operation aborted");
  });

  it("an empty transcript says so", () => {
    expect(text(view([]))).toContain("empty transcript");
  });

  it("a transcript ends with a blank line, never flush against the prompt", () => {
    expect(lines(view([user("hello")])).at(-1)).toBe("");
  });

  it("a reset and a compaction each render a note", () => {
    expect(text(view([entry("pi.reset")]))).toContain("context reset");
    expect(text(view([entry("pi.compaction")]))).toContain("compacted");
  });
});

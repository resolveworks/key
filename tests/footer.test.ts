import type {
  ContextView,
  EntryRecord,
  LiveState,
  TranscriptView,
} from "@earendil-works/pi-durable";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { contextTokens, Footer, shortenHome, tokens, totals } from "../src/footer.ts";

// A run in flight: the branded task ID is the package's to allocate, so the fake view brands one.
const liveRun = { run: { taskId: 1, inputs: [], turns: 0 } } as unknown as LiveState;

const view = (
  entries: readonly EntryRecord[],
  cwd = "/key/repo",
  live = false,
  agent: { readonly modelId?: string; readonly thinkingLevel?: string } = {
    modelId: "deepseek-flash",
    thinkingLevel: "high",
  },
): TranscriptView =>
  ({
    conversation: {} as TranscriptView["conversation"],
    items: entries.map((entry) => ({ kind: "entry", entry })),
    docs: {
      "pi.agent": {
        cwd,
        ...(agent.modelId === undefined
          ? {}
          : { model: { provider: "deepseek", modelId: agent.modelId } }),
        ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
      },
      "pi.live": live ? liveRun : undefined,
      "pi.usage": usage,
    },
  }) as unknown as TranscriptView;

const usage = {
  models: {
    "deepseek/deepseek-flash": {
      input: 1200,
      output: 340,
      cacheRead: 8600,
      cacheWrite: 200,
      totalTokens: 10340,
      cost: { input: 0.0012, output: 0.0004, cacheRead: 0.0001, cacheWrite: 0, total: 0.0017 },
    },
  },
  tools: {},
};

const answered = (input: number, cacheRead: number, timestamp = 0): EntryRecord =>
  ({
    id: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input,
          output: 5,
          cacheRead,
          cacheWrite: 0,
          totalTokens: input + cacheRead + 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp,
      },
    ],
  }) as unknown as EntryRecord;

const context = (entries: readonly EntryRecord[]): ContextView => ({
  head: undefined,
  entries,
  contributions: entries.map((entry) => entry.model ?? []),
  messages: entries.flatMap((entry) => entry.model ?? []),
});

/** A human turn, as durable records it: a `pi.user` entry carrying one user message. */
const asked = (prompt: string): EntryRecord =>
  ({
    id: 1,
    kind: "pi.user",
    model: [{ role: "user", content: prompt, timestamp: 0 }],
  }) as unknown as EntryRecord;

describe("footer", () => {
  test("token counts read as pi's compact ones", () => {
    expect([812, 6400, 21000, 1_300_000, 12_400_000].map(tokens)).toEqual([
      "812",
      "6.4k",
      "21k",
      "1.3M",
      "12M",
    ]);
  });

  test("a path inside home shows as ~, one outside it stays whole", () => {
    expect(shortenHome("/etc")).toBe("/etc");
    expect(shortenHome(process.env.HOME ?? "/")).toBe("~");
    expect(shortenHome(`${process.env.HOME ?? ""}/Projects/key`)).toBe("~/Projects/key");
  });

  test("the spend is every bucket the conversation recorded, answers and tools alike", () => {
    const bucket = (input: number, cacheRead: number, total: number) => ({
      input,
      output: 0,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    const spent = totals({
      models: { "deepseek/a": bucket(1200, 8600, 0.001), "deepseek/b": bucket(300, 400, 0.0005) },
      tools: { bash: bucket(50, 0, 0.0002) },
    } as never);
    expect(spent.input).toBe(1550);
    expect(spent.cacheRead).toBe(9000);
    expect(spent.cost.total).toBeCloseTo(0.0017);
  });

  test("with nothing answered yet the context is an estimate of what was sent", () => {
    const user = { id: 1, kind: "pi.user", model: [{ role: "user", content: "x".repeat(400) }] };
    expect(contextTokens(context([user as unknown as EntryRecord]))).toBeGreaterThan(100);
  });

  test("two dim lines: where it runs, and what it spent against the window", () => {
    const footer = new Footer();
    const entries = [asked("fix the footer"), answered(1200, 8600)];
    footer.watch(
      view(entries, "/key/repo"),
      {
        branch: "main",
        contextWindow: 128_000,
      },
      contextTokens(context(entries)),
    );
    const [place, spent] = footer.render(100);
    expect(place).toContain("/key/repo");
    expect(place).toContain("(main)");
    expect(spent).toContain("↑1.2k");
    expect(spent).toContain("7.7%/128k");
    expect(spent).toContain("deepseek-flash • high");
    expect(visibleWidth(spent)).toBeLessThanOrEqual(100);
  });

  test("the place line carries the place alone", () => {
    const footer = new Footer();
    footer.watch(
      view([asked("fix the footer test flake\n\nthen the rest")]),
      {
        contextWindow: 128_000,
      },
      0,
    );
    const [place] = footer.render(100);
    expect(stripTerminalSequences(place)).toBe("/key/repo");
  });

  test("a fresh trajectory names where it would run and nothing it has spent", () => {
    const footer = new Footer();
    footer.show("/key/repo");
    expect(footer.render(80).map(stripTerminalSequences)).toEqual(["/key/repo"]);
  });

  test("the selector owns the whole screen: cleared, the footer draws nothing", () => {
    const footer = new Footer();
    footer.show("/key/repo");
    footer.clear();
    expect(footer.render(80)).toEqual([]);
  });

  test("the stats line opens with a dot: filled while the conversation streams, hollow once it settles", () => {
    const stats = { contextWindow: 128_000 };
    const footer = new Footer();
    footer.watch(view([answered(1200, 8600)], "/key/repo", true), stats, 0);
    expect(stripTerminalSequences(footer.render(100)[1] ?? "")).toMatch(/^● ↑1\.2k/);

    footer.watch(view([answered(1200, 8600)]), stats, 0);
    expect(stripTerminalSequences(footer.render(100)[1] ?? "")).toMatch(/^○ ↑1\.2k/);
  });
});

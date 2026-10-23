import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { cycleRunning, freshCwd, keybinds, line, targetCwd } from "../src/client.ts";
import { dot } from "../src/footer.ts";
import type { Summary } from "../src/host.ts";
import { style } from "../src/theme.ts";

const summary = (id: number, running: boolean, depth = 0): Summary => ({
  id,
  label: `ask ${id}`,
  cwd: "/key/repo",
  running,
  depth,
});

// The host lists by cascade, newest cascade first; parked contexts stay in the list but never in
// the ring.
const summaries = [summary(5, true), summary(4, false), summary(3, true), summary(1, true)];

describe("cycleRunning", () => {
  test("from a running context it steps to the running neighbor, wrapping both ways", () => {
    expect(cycleRunning(summaries, 5, 1)).toBe(3);
    expect(cycleRunning(summaries, 3, 1)).toBe(1);
    expect(cycleRunning(summaries, 1, 1)).toBe(5);
    expect(cycleRunning(summaries, 5, -1)).toBe(1);
    expect(cycleRunning(summaries, 1, -1)).toBe(3);
    expect(cycleRunning(summaries, 3, -1)).toBe(5);
  });

  test("from any other view it lands on the first running forward, the last backward", () => {
    expect(cycleRunning(summaries, undefined, 1)).toBe(5);
    expect(cycleRunning(summaries, undefined, -1)).toBe(1);
    expect(cycleRunning(summaries, 4, 1)).toBe(5);
    expect(cycleRunning(summaries, 4, -1)).toBe(1);
  });

  test("a lone running context is its own neighbor", () => {
    expect(cycleRunning([summary(4, false), summary(3, true)], 3, 1)).toBe(3);
    expect(cycleRunning([summary(4, false), summary(3, true)], 3, -1)).toBe(3);
  });

  test("with nothing running there is nowhere to go", () => {
    const parked = [summary(2, false), summary(1, false)];
    expect(cycleRunning(parked, undefined, 1)).toBeUndefined();
    expect(cycleRunning(parked, 1, -1)).toBeUndefined();
  });
});

describe("line", () => {
  test("depth 0 sits flush left at the dot", () => {
    expect(line(summary(4, false))).toBe(`${dot(false)} ${style.dim("repo")} · ask 4`);
  });

  test("each level of depth steps the dot in two spaces, the tail unchanged", () => {
    expect(line(summary(4, false, 1))).toBe(`  ${dot(false)} ${style.dim("repo")} · ask 4`);
    expect(line(summary(5, true, 2))).toBe(`    ${dot(true)} ${style.dim("repo")} · ask 5`);
  });
});

describe("targetCwd", () => {
  test("an absolute path stands, a relative one resolves against the client's cwd", () => {
    expect(targetCwd(tmpdir())).toBe(tmpdir());
    expect(targetCwd(".")).toBe(process.cwd());
  });

  test("~ is home, with or without a path under it", () => {
    expect(targetCwd("~")).toBe(homedir());
    expect(targetCwd("~/")).toBe(homedir());
  });

  test("whatever does not name a directory throws", () => {
    expect(() => targetCwd(resolve(tmpdir(), "key-no-such-dir"))).toThrow(/ENOENT/);
    // This file is a file.
    expect(() => targetCwd(import.meta.filename)).toThrow("not a directory");
  });
});

describe("freshCwd", () => {
  const client = "/key/client";

  test("a named path wins, whatever was open before", () => {
    expect(freshCwd("/key/elsewhere", summary(3, true), client)).toBe("/key/elsewhere");
    expect(freshCwd("/key/elsewhere", undefined, client)).toBe("/key/elsewhere");
  });

  test("unnamed, the abandoned conversation's directory is the default", () => {
    expect(freshCwd(undefined, summary(3, true), client)).toBe("/key/repo");
  });

  test("with nothing to abandon — or a cwd it never wrote — the client's own directory", () => {
    expect(freshCwd(undefined, undefined, client)).toBe(client);
    expect(freshCwd(undefined, { ...summary(3, true), cwd: "" }, client)).toBe(client);
  });
});

describe("keybinds", () => {
  test("every override names a real pi-tui action", () => {
    // pi-tui skips an unknown action without a word, so a typo here would never fire.
    for (const action of Object.keys(keybinds))
      expect(action in TUI_KEYBINDINGS, action).toBe(true);
  });
});

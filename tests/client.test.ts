import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { cycle, freshCwd, keybinds, line, stepList, targetCwd } from "../src/client.ts";
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

// The host lists by cascade, newest cascade first; finished contexts stay in the list but never
// in the ring. The composer joins the ring only while a trajectory is being written in it — an
// empty `/new` is no place at all.
const summaries = [summary(5, true), summary(4, false), summary(3, true), summary(1, true)];
const draft = "fix the flaky test";

describe("cycle", () => {
  test("a drafted composer leads the ring, then the running contexts in the list's order", () => {
    expect(cycle(summaries, "new", 1, draft)).toBe(5); // forward from the composer: the newest running
    expect(cycle(summaries, "new", -1, draft)).toBe(1); // back from the composer: the oldest running
    expect(cycle(summaries, 1, 1, draft)).toBe("new"); // forward off the oldest wraps onto the composer
    expect(cycle(summaries, 5, -1, draft)).toBe("new"); // back off the newest wraps onto the composer
  });

  test("from a running context it steps to the running neighbor, wrapping both ways", () => {
    expect(cycle(summaries, 5, 1, draft)).toBe(3);
    expect(cycle(summaries, 3, 1, draft)).toBe(1);
    expect(cycle(summaries, 3, -1, draft)).toBe(5);
    expect(cycle(summaries, 1, -1, draft)).toBe(3);
  });

  test("the ring follows the tree, crossing cascade blocks whole", () => {
    // Two cascades, newest block first: each kickoff with a running fork beneath it.
    const tree = [summary(2, true), summary(5, true, 1), summary(1, true), summary(3, true, 1)];
    expect(cycle(tree, 5, 1, draft)).toBe(1); // off the top cascade into the older one
    expect(cycle(tree, 3, 1, draft)).toBe("new"); // off the oldest, onto the composer
  });

  test("from a settled conversation it lands on the first running forward, the last back", () => {
    expect(cycle(summaries, 4, 1, "")).toBe(5);
    expect(cycle(summaries, 4, -1, "")).toBe(1);
  });

  test("an empty composer is no place: the ring is the running contexts alone", () => {
    expect(cycle(summaries, 1, 1, "")).toBe(5); // off the oldest wraps onto the newest
    expect(cycle(summaries, 5, -1, "")).toBe(1);
    expect(cycle(summaries, 3, 1, " ")).toBe(1); // whitespace is nothing typed
  });

  test("a lone running context is its own neighbor while the composer is empty", () => {
    const lone = [summary(4, false), summary(3, true)];
    expect(cycle(lone, 3, 1, "")).toBe(3);
    expect(cycle(lone, 3, -1, "")).toBe(3);
  });

  test("a drafted composer alone is the whole ring: every step lands on it", () => {
    const finished = [summary(2, false), summary(1, false)];
    expect(cycle(finished, "new", 1, draft)).toBe("new");
    expect(cycle(finished, 1, 1, draft)).toBe("new");
  });

  test("nothing live — nothing running, nothing drafted — is nowhere to go", () => {
    const finished = [summary(2, false), summary(1, false)];
    expect(cycle(finished, 1, 1, "")).toBeUndefined();
    expect(cycle(finished, "new", -1, "")).toBeUndefined();
    expect(cycle([], "new", 1, "")).toBeUndefined();
  });
});

describe("stepList", () => {
  // Three cascades, newest block first: kickoffs 7, 2, and 1, the first two levels deep.
  const tree = [
    summary(7, false),
    summary(6, false, 1),
    summary(5, false, 2),
    summary(2, false),
    summary(4, false, 1),
    summary(1, false),
  ];

  test("n and e step one line, wrapping both ways", () => {
    expect(stepList(tree, 7, "line", 1)).toBe(6);
    expect(stepList(tree, 6, "line", -1)).toBe(7);
    expect(stepList(tree, 1, "line", 1)).toBe(7); // off the bottom onto the top
    expect(stepList(tree, 7, "line", -1)).toBe(1); // off the top onto the bottom
  });

  test("y and o step one cascade, landing on the kickoff, wrapping both ways", () => {
    expect(stepList(tree, 4, "cascade", -1)).toBe(7); // deep in a block, onto the one before it
    expect(stepList(tree, 5, "cascade", -1)).toBe(1); // the newest wraps to the oldest
    expect(stepList(tree, 2, "cascade", -1)).toBe(7);
    expect(stepList(tree, 1, "cascade", -1)).toBe(2);
    expect(stepList(tree, 7, "cascade", 1)).toBe(2);
    expect(stepList(tree, 4, "cascade", 1)).toBe(1);
    expect(stepList(tree, 1, "cascade", 1)).toBe(7); // the oldest wraps to the newest
  });

  test("a lone cascade is its own neighbor: both ways land on its kickoff", () => {
    const one = [summary(3, false), summary(2, false, 1)];
    expect(stepList(one, 2, "cascade", -1)).toBe(3);
    expect(stepList(one, 3, "cascade", 1)).toBe(3);
  });

  test("with nothing selected it starts from the top; with nothing listed, nowhere to go", () => {
    expect(stepList(tree, undefined, "line", 1)).toBe(6);
    expect(stepList(tree, undefined, "cascade", 1)).toBe(2);
    expect(stepList([], undefined, "line", 1)).toBeUndefined();
    expect(stepList([], 3, "cascade", -1)).toBeUndefined();
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

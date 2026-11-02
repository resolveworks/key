import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { cycle, freshCwd, inheritCwd, keybinds, line, stepList, targetCwd } from "../src/client.ts";
import { dot } from "../src/footer.ts";
import type { Summary } from "../src/host.ts";
import { style } from "../src/theme.ts";

const summary = (id: number, attention: boolean, depth = 0, streaming = false): Summary => ({
  id,
  label: `ask ${id}`,
  cwd: "/key/repo",
  depth,
  streaming,
  attention,
});

/** A delegated child's conversation, as the host lists it: depth 1 under its kickoff, its cwd the
 * worktree its name minted — elsewhere than the checkout it was cut from. */
const child = (id: number, name: string, attention = false): Summary => ({
  ...summary(id, attention, 1),
  cwd: `/key/worktrees/${name}`,
});

// The host lists by cascade, newest cascade first; only conversations that need a human join the
// ring. The composer joins it too only while a trajectory is being written in it — an empty
// `/new` is no place at all.
const summaries = [summary(5, true), summary(4, false), summary(3, true), summary(1, true)];
const draft = "fix the flaky test";

describe("cycle", () => {
  test("a drafted composer leads the ring, then the conversations needing attention", () => {
    expect(cycle(summaries, "new", 1, draft)).toBe(5); // forward from the composer: the newest attention
    expect(cycle(summaries, "new", -1, draft)).toBe(1); // back from the composer: the oldest attention
    expect(cycle(summaries, 1, 1, draft)).toBe("new"); // forward off the oldest wraps onto the composer
    expect(cycle(summaries, 5, -1, draft)).toBe("new"); // back off the newest wraps onto the composer
  });

  test("from an attention conversation it steps to the attention neighbor, wrapping both ways", () => {
    expect(cycle(summaries, 5, 1, draft)).toBe(3);
    expect(cycle(summaries, 3, 1, draft)).toBe(1);
    expect(cycle(summaries, 3, -1, draft)).toBe(5);
    expect(cycle(summaries, 1, -1, draft)).toBe(3);
  });

  test("the ring follows the tree, crossing cascade blocks whole", () => {
    // Two cascades, newest block first: each kickoff with an attention child beneath it.
    const tree = [summary(2, true), summary(5, true, 1), summary(1, true), summary(3, true, 1)];
    expect(cycle(tree, 5, 1, draft)).toBe(1); // off the top cascade into the older one
    expect(cycle(tree, 3, 1, draft)).toBe("new"); // off the oldest, onto the composer
  });

  test("from a settled conversation it lands on the first attention forward, the last back", () => {
    expect(cycle(summaries, 4, 1, "")).toBe(5);
    expect(cycle(summaries, 4, -1, "")).toBe(1);
  });

  test("an empty composer is no place: the ring is the attention conversations alone", () => {
    expect(cycle(summaries, 1, 1, "")).toBe(5); // off the oldest wraps onto the newest
    expect(cycle(summaries, 5, -1, "")).toBe(1);
    expect(cycle(summaries, 3, 1, " ")).toBe(1); // whitespace is nothing typed
  });

  test("a lone attention conversation is its own neighbor while the composer is empty", () => {
    const lone = [summary(4, false), summary(3, true)];
    expect(cycle(lone, 3, 1, "")).toBe(3);
    expect(cycle(lone, 3, -1, "")).toBe(3);
  });

  test("a drafted composer alone is the whole ring: every step lands on it", () => {
    const finished = [summary(2, false), summary(1, false)];
    expect(cycle(finished, "new", 1, draft)).toBe("new");
    expect(cycle(finished, 1, 1, draft)).toBe("new");
  });

  test("nothing needs attention — nothing marked, nothing drafted — is nowhere to go", () => {
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
  const warning = style.warning("!");

  test("the green dot streams and the amber mark asks, with depth indenting both", () => {
    expect(line(summary(4, false))).toBe(`${dot(false)}   ${style.dim("repo")} · ask 4`);
    expect(line(summary(5, true))).toBe(`${dot(false)} ${warning} ${style.dim("repo")} · ask 5`);
    expect(line(summary(6, false, 1, true))).toBe(`  ${dot(true)}   ${style.dim("repo")} · ask 6`);
    expect(line(summary(7, true, 2, true))).toBe(
      `    ${dot(true)} ${warning} ${style.dim("repo")} · ask 7`,
    );
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

describe("inheritCwd", () => {
  test("a conversation in its own checkout hands that checkout", () => {
    expect(inheritCwd([summary(1, true), child(2, "fix")], 1)).toBe("/key/repo");
  });

  test("a child hands its cascade's kickoff, not its worktree", () => {
    expect(inheritCwd([summary(1, true), child(2, "fix")], 2)).toBe("/key/repo");
  });

  test("a child hands its own cascade's kickoff, not the newer block's", () => {
    const listed = [
      { ...summary(9, true), cwd: "/key/other" },
      child(10, "late"),
      summary(1, false),
      child(2, "fix", true),
      child(3, "also"),
    ];
    expect(inheritCwd(listed, 3)).toBe("/key/repo");
    expect(inheritCwd(listed, 10)).toBe("/key/other");
  });

  test("a conversation the host never listed hands nothing", () => {
    expect(inheritCwd([summary(1, true)], 7)).toBe("");
  });
});

describe("keybinds", () => {
  test("every override names a real pi-tui action", () => {
    // pi-tui skips an unknown action without a word, so a typo here would never fire.
    for (const action of Object.keys(keybinds))
      expect(action in TUI_KEYBINDINGS, action).toBe(true);
  });
});

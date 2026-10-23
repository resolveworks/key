import {
  CURSOR_MARKER,
  type EditorTheme,
  renderFakeCursor,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { Prompt, provider } from "../src/prompt.ts";
import { style } from "../src/theme.ts";

const signal = new AbortController().signal;
// The host's stand-in: one answer, handed back to the editor untouched.
const answer = { items: [{ value: "src/", label: "src/" }], prefix: "sr" };

describe("provider", () => {
  test("an unforced slash line completes the client's own commands, never asking the host", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete).getSuggestions(["/re"], 0, 3, { signal });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items.map((item) => item.value)).toContain("resume");
  });

  test("every other line is the host's, as it stands before the cursor", async () => {
    const complete = vi.fn().mockResolvedValue(answer);
    const typed = await provider(complete).getSuggestions(["look at sr"], 0, 10, { signal });
    expect(complete).toHaveBeenNthCalledWith(1, "look at sr", false, signal);
    expect(typed).toBe(answer);

    // Tab on a slash line is a forced completion: a path, not a command, so still the host's.
    const forced = await provider(complete).getSuggestions(["/re"], 0, 3, { signal, force: true });
    expect(complete).toHaveBeenNthCalledWith(2, "/re", true, signal);
    expect(forced).toBe(answer);
  });
});

describe("Prompt", () => {
  // An editor that never touches a terminal: rendering asks only for its rows.
  const tui = { terminal: { rows: 30 } } as unknown as TUI;
  const theme = { borderColor: (text: string) => text } as unknown as EditorTheme;

  const input = (ghost: () => string = () => "/key/repo"): Prompt => {
    const prompt = new Prompt(tui, theme, ghost);
    prompt.focused = true; // the focused cursor is the cell the ghost follows
    return prompt;
  };

  test("/new typed to its end ghosts the default in the line, behind the cursor's cell", () => {
    const prompt = input();
    prompt.setText("/new");
    const lines = prompt.render(40);
    const line = lines.find((l) => l.includes(style.dim("/key/repo")));
    if (line === undefined) throw new Error(`no ghost on the line: ${JSON.stringify(lines)}`);
    // The ghost follows the cursor's cell, and the line keeps the width it had.
    expect(line.indexOf(style.dim("/key/repo"))).toBeGreaterThan(line.indexOf(CURSOR_MARKER));
    expect(visibleWidth(line)).toBe(40);

    // The space tab-completion leaves behind counts as the command's end too.
    prompt.setText("/new ");
    expect(prompt.render(40).some((l) => l.includes(style.dim("/key/repo")))).toBe(true);
  });

  test("any other line draws no ghost", () => {
    const prompt = input();
    for (const text of ["/new ~/elsewhere", "/resume", "hello", ""]) {
      prompt.setText(text);
      expect(prompt.render(40).some((l) => l.includes("/key/repo"))).toBe(false);
    }
  });

  test("a ghost longer than the room behind the cursor truncates, keeping the width", () => {
    const prompt = input(() => "/home/johan/Projects/key");
    prompt.setText("/new");
    const line = prompt.render(12).find((l) => l.includes("…"));
    expect(line).toBeDefined();
    expect(visibleWidth(line ?? "")).toBe(12);
    expect(line?.includes(renderFakeCursor(" "))).toBe(true);
  });
});

import { homedir } from "node:os";
import { SelectList, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { provider } from "../src/prompt.ts";
import { selectTheme } from "../src/theme.ts";

const signal = new AbortController().signal;
// The default's stand-in: the path /new's completion carries.
const freshDefault = "~/somewhere";

describe("provider", () => {
  test("an unforced slash line completes the client's own commands, never asking the host", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete, () => freshDefault).getSuggestions(["/li"], 0, 3, {
      signal,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items.map((item) => item.value)).toContain("list");
  });

  test("/tree completes to the transcript fork picker", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete, () => freshDefault).getSuggestions(["/tr"], 0, 3, {
      signal,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items).toEqual([
      { value: "tree", label: "tree", description: "fork from a transcript entry" },
    ]);
  });

  test("/new's completion names the command, with the path it would run beside it", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete, () => freshDefault).getSuggestions(["/ne"], 0, 3, {
      signal,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items).toEqual([
      { value: "new", label: "new", description: "~/somewhere — start fresh" },
    ]);
  });

  test("/new starts bare without a selected conversation and reads the selection live", async () => {
    let cwd: string | undefined;
    const autocomplete = provider(vi.fn(), () => cwd);
    expect((await autocomplete.getSuggestions(["/ne"], 0, 3, { signal }))?.items).toEqual([
      { value: "new", label: "new", description: "start fresh" },
    ]);

    cwd = "/host/repo";
    expect((await autocomplete.getSuggestions(["/ne"], 0, 3, { signal }))?.items).toEqual([
      { value: "new", label: "new", description: "/host/repo — start fresh" },
    ]);
  });

  test("/new's path survives the suggestion row's narrow name column, home-shortened", async () => {
    // The editor clamps a command's name to 32 columns and cuts the rest without an ellipsis:
    // a path in the name column would lose its leaf, so the row must read whole in the row.
    const cwd = `${homedir()}/.key/worktrees/key-e01a74c8/sandbox-gitdir`;
    const suggestions = await provider(vi.fn(), () => cwd).getSuggestions(["/new"], 0, 4, {
      signal,
    });
    expect(suggestions?.items).toEqual([
      {
        value: "new",
        label: "new",
        description: "~/.key/worktrees/key-e01a74c8/sandbox-gitdir — start fresh",
      },
    ]);

    const list = new SelectList(suggestions?.items ?? [], 5, selectTheme, {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 32,
    });
    const row = stripTerminalSequences(list.render(90)[0] ?? "");
    expect(row).toContain("~/.key/worktrees/key-e01a74c8/sandbox-gitdir");
    expect(row).toContain("start fresh");
  });

  test("every other line is the host's, as it stands before the cursor", async () => {
    const complete = vi.fn();
    const autocomplete = provider(complete, () => freshDefault);
    await autocomplete.getSuggestions(["look at sr"], 0, 10, { signal });
    expect(complete).toHaveBeenNthCalledWith(1, "look at sr", false, signal);

    // A cursor mid-line asks for what stands before it, not the tail after.
    await autocomplete.getSuggestions(["look at sr"], 0, 7, { signal });
    expect(complete).toHaveBeenNthCalledWith(2, "look at", false, signal);

    // Tab on a slash line is a forced completion: a path, not a command, so still the host's.
    await autocomplete.getSuggestions(["/li"], 0, 3, { signal, force: true });
    expect(complete).toHaveBeenNthCalledWith(3, "/li", true, signal);
  });

  test("applying /new's completion lands the command alone, room to drill behind", () => {
    // The editor applies against the item and the prefix it was answered with: what the send
    // takes is a bare `/new`, which runs where the suggestion named, and further tabs complete
    // the path on the host.
    const applied = provider(vi.fn(), () => freshDefault).applyCompletion(
      ["/n"],
      0,
      2,
      { value: "new", label: "new" },
      "/n",
    );
    expect(applied).toEqual({
      lines: ["/new "],
      cursorLine: 0,
      cursorCol: "/new ".length,
    });
  });
});

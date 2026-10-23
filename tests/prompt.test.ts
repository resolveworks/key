import { describe, expect, test, vi } from "vitest";
import { provider } from "../src/prompt.ts";

const signal = new AbortController().signal;
// The host's stand-in: one answer, handed back to the editor untouched.
const answer = { items: [{ value: "src/", label: "src/" }], prefix: "sr" };
// The default's stand-in: the path /new's completion carries.
const freshDefault = () => "~/somewhere";

describe("provider", () => {
  test("an unforced slash line completes the client's own commands, never asking the host", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete, freshDefault).getSuggestions(["/li"], 0, 3, {
      signal,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items.map((item) => item.value)).toContain("list");
  });

  test("/new's completion is the command and the path it would run, one item", async () => {
    const complete = vi.fn();
    const suggestions = await provider(complete, freshDefault).getSuggestions(["/n"], 0, 2, {
      signal,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(suggestions?.items).toEqual([
      { value: "new ~/somewhere", label: "new ~/somewhere", description: "start fresh" },
    ]);
  });

  test("every other line is the host's, as it stands before the cursor", async () => {
    const complete = vi.fn().mockResolvedValue(answer);
    const typed = await provider(complete, freshDefault).getSuggestions(["look at sr"], 0, 10, {
      signal,
    });
    expect(complete).toHaveBeenNthCalledWith(1, "look at sr", false, signal);
    expect(typed).toBe(answer);

    // Tab on a slash line is a forced completion: a path, not a command, so still the host's.
    const forced = await provider(complete, freshDefault).getSuggestions(["/li"], 0, 3, {
      signal,
      force: true,
    });
    expect(complete).toHaveBeenNthCalledWith(2, "/li", true, signal);
    expect(forced).toBe(answer);
  });

  test("applying /new's completion lands the command with its path, room to drill behind", () => {
    // The editor applies against the item and the prefix it was answered with: what the send
    // takes is `/new` naming where it runs, and further tabs complete the path on the host.
    const applied = provider(vi.fn(), freshDefault).applyCompletion(
      ["/n"],
      0,
      2,
      { value: "new ~/somewhere", label: "new ~/somewhere" },
      "/n",
    );
    expect(applied).toEqual({
      lines: ["/new ~/somewhere "],
      cursorLine: 0,
      cursorCol: "/new ~/somewhere ".length,
    });
  });
});

import { describe, expect, test, vi } from "vitest";
import { provider } from "../src/prompt.ts";

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

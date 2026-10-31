// The prompt's completions: the client's slash commands, answered here — `/new` carrying the
// directory a bare one would run, so a tab names it outright — and every path, tab completion
// and @file suggestions alike, answered by the host, whose filesystem is the one the
// trajectories run on.

import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";

/** The client's provider: `complete` answers one line of prompt on the host, `freshDefault`
 * names where a bare `/new` would run — the path is part of its completion, not an argument
 * left to type. */
export function provider(
  complete: (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ) => Promise<AutocompleteSuggestions | null>,
  freshDefault: () => string,
): AutocompleteProvider {
  // Built per ask: the default moves with the place `/new` would leave.
  const commands = (): AutocompleteItem[] => [
    { value: "list", label: "list", description: "list past conversations" },
    {
      value: "model",
      label: "model",
      description: "set the conversation and child defaults",
    },
    { value: `new ${freshDefault()}`, label: `new ${freshDefault()}`, description: "start fresh" },
  ];
  // The library's provider kept for its text grammar alone: an unforced line that starts with "/"
  // is its command branch, and the client's commands are the only ones. No path is ever answered
  // against this filesystem.
  const local = () => new CombinedAutocompleteProvider(commands(), "");
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
      return options.force !== true && text.trimStart().startsWith("/")
        ? local().getSuggestions(lines, cursorLine, cursorCol, options)
        : complete(text, options.force ?? false, options.signal);
    },
    applyCompletion: (...args) => local().applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => local().shouldTriggerFileCompletion(...args),
  };
}

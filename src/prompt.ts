// The prompt's completions: the client's slash commands, answered here, and every path — tab
// completion and @file suggestions alike — answered by the host, whose filesystem is the one the
// trajectories run on.

import {
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";

const commands: SlashCommand[] = [
  { name: "resume", description: "list past conversations" },
  { name: "new", description: "start fresh; an optional path sets the directory it runs in" },
];

/** The client's provider: `complete` is the host's answer for one line of prompt. */
export function provider(
  complete: (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ) => Promise<AutocompleteSuggestions | null>,
): AutocompleteProvider {
  // The library's provider kept for its text grammar alone: an unforced line that starts with "/"
  // is its command branch, and the client's commands are the only ones. No path is ever answered
  // against this filesystem.
  const local = new CombinedAutocompleteProvider(commands, "");
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
      return options.force !== true && text.trimStart().startsWith("/")
        ? local.getSuggestions(lines, cursorLine, cursorCol, options)
        : complete(text, options.force ?? false, options.signal);
    },
    applyCompletion: (...args) => local.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => local.shouldTriggerFileCompletion(...args),
  };
}

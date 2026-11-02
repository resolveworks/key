// The prompt's completions: the client's slash commands answered here — `/new` carrying the
// directory a bare one would run — and every path answered by the host, whose filesystem is the
// one the trajectories run on.

import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";

export function provider(
  complete: (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ) => Promise<AutocompleteSuggestions | null>,
  freshDefault: string,
): AutocompleteProvider {
  // The directory a bare `/new` would run, fixed where the provider was built.
  const commands = (): AutocompleteItem[] => [
    { value: "list", label: "list", description: "list past conversations" },
    {
      value: "model",
      label: "model",
      description: "set the conversation and child defaults",
    },
    {
      value: "thinking",
      label: "thinking",
      description: "set the conversation and child thinking defaults",
    },
    {
      value: "login",
      label: "login",
      description: "configure a provider",
    },
    { value: `new ${freshDefault}`, label: `new ${freshDefault}`, description: "start fresh" },
  ];
  // The library's provider kept for its text grammar alone: an unforced line that starts with
  // "/" is its command branch, and the client's commands are the only ones — no path is ever
  // answered against this filesystem.
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

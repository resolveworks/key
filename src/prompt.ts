// The prompt's completions: built-in slash commands answered here — `/new` naming the
// directory a bare one would run — and skills and paths answered by the host, whose filesystem
// is the one the trajectories run on.

import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { shortenHome } from "./footer.ts";

export function provider(
  complete: (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ) => Promise<AutocompleteSuggestions | null>,
  freshDefault: () => string | undefined,
): AutocompleteProvider {
  // The name column is clamped narrow and cut without an ellipsis, so a fresh path rides the
  // argument hint beside it, where it reads whole.
  const commands = (): (AutocompleteItem | SlashCommand)[] => {
    const cwd = freshDefault();
    return [
      { value: "list", label: "list", description: "list past conversations" },
      { value: "tree", label: "tree", description: "fork from a transcript entry" },
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
      cwd === undefined
        ? { value: "new", label: "new", description: "start fresh" }
        : { name: "new", argumentHint: shortenHome(cwd), description: "start fresh" },
    ];
  };
  // The library's provider kept for its text grammar alone: an unforced line that starts with
  // "/" is its command branch. The local list holds built-ins; skill commands merge from the host.
  const local = () => new CombinedAutocompleteProvider(commands(), "");
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = lines[cursorLine].slice(0, cursorCol);
      const command = text.trimStart();
      if (options.force === true || !command.startsWith("/"))
        return complete(text, options.force ?? false, options.signal);
      const suggestions = await local().getSuggestions(lines, cursorLine, cursorCol, options);
      if (!("/skill:".startsWith(command) || command.startsWith("/skill:"))) return suggestions;
      const skills = await complete(text, false, options.signal);
      if (skills === null) return suggestions;
      if (suggestions === null) return skills;
      return { items: [...suggestions.items, ...skills.items], prefix: suggestions.prefix };
    },
    applyCompletion: (...args) => local().applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => local().shouldTriggerFileCompletion(...args),
  };
}

// The prompt: its completions — the client's slash commands, answered here, and every path, tab
// completion and @file suggestions alike, answered by the host, whose filesystem is the one the
// trajectories run on — and its input, which ghosts where a bare `/new` would run.

import {
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  type EditorOptions,
  type EditorTheme,
  renderFakeCursor,
  type SlashCommand,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

const commands: SlashCommand[] = [
  { name: "resume", description: "list past conversations" },
  { name: "new", description: "start fresh" },
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

/** The prompt's input: an editor that ghosts the directory a bare `/new` would run in — drawn in
 * the line itself, right where a path argument would sit, rather than a message about it below. */
export class Prompt extends Editor {
  readonly #ghost: () => string;

  constructor(tui: TUI, theme: EditorTheme, ghost: () => string, options?: EditorOptions) {
    super(tui, theme, options);
    this.#ghost = ghost;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const text = this.getText();
    const cursor = this.getCursor();
    // Only the command itself, typed to its end: a path of its own answers the question, and a
    // cursor moved away means the ghost would not sit where the argument goes.
    if (!/^\/new ?$/.test(text) || cursor.line !== 0 || cursor.col !== text.length) return lines;
    // The cursor's one highlighted cell closes the typed command; the ghost takes the blank room
    // behind it, so the line keeps its width and the box around it never moves.
    const cell = CURSOR_MARKER + renderFakeCursor(" ");
    const at = lines.findIndex((line) => line.includes(cell));
    if (at === -1) return lines;
    const end = lines[at].indexOf(cell) + cell.length;
    const room = visibleWidth(lines[at].slice(end));
    const ghost = truncateToWidth(this.#ghost(), room, "…");
    const rest = " ".repeat(room - visibleWidth(ghost));
    lines[at] = `${lines[at].slice(0, end)}${style.dim(ghost)}${rest}`;
    return lines;
  }
}

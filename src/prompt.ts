// The prompt: its completions — the client's slash commands, answered here, and every path, tab
// completion and @file suggestions alike, answered by the host, whose filesystem the trajectories
// run on — and its input, which ghosts where a bare `/new` would run, one tab from typed.

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
  { name: "list", description: "list past conversations" },
  { name: "new", description: "start fresh" },
];

/** The ghost's one grammar, for both of its readers: the line is `/new` alone — a path of its
 * own answers the question — with the cursor on its end, the space tab-completion leaves included. */
const ghosted = (lines: string[], line: number, col: number): boolean =>
  line === 0 && lines.length === 1 && /^\/new ?$/.test(lines[0] ?? "") && col === lines[0].length;

/** The client's provider: `complete` answers one line of prompt on the host, `ghost` the default a tab accepts. */
export function provider(
  complete: (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ) => Promise<AutocompleteSuggestions | null>,
  ghost: () => string,
): AutocompleteProvider {
  // The library's provider kept for its text grammar alone: an unforced line that starts with "/"
  // is its command branch, and the client's commands are the only ones. No path is ever answered
  // against this filesystem.
  const local = new CombinedAutocompleteProvider(commands, "");
  // Where a tab accepts the ghost: its argument seat, the space typed. Nowhere else does a forced
  // tab land dead — a bare `/new` the editor completes as a command, the rest the library gates.
  const accepts = (lines: string[], line: number, col: number): boolean =>
    ghosted(lines, line, col) && lines[line].endsWith(" ");
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.force === true && accepts(lines, cursorLine, cursorCol))
        // The drawn default becomes the typed argument, without asking the host: one suggestion,
        // so the editor applies it outright, the empty prefix landing it after the space.
        return { items: [{ value: ghost(), label: ghost() }], prefix: "" };
      const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
      return options.force !== true && text.trimStart().startsWith("/")
        ? local.getSuggestions(lines, cursorLine, cursorCol, options)
        : complete(text, options.force ?? false, options.signal);
    },
    applyCompletion: (...args) => local.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) =>
      accepts(...args) || local.shouldTriggerFileCompletion(...args),
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
    const cursor = this.getCursor();
    if (!ghosted(this.getLines(), cursor.line, cursor.col)) return lines;
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

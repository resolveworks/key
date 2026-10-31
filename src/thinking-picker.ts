// The `/thinking` picker: every level pi-ai knows, the session default in view. Enter sets it and
// closes; escape closes without a change.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, SelectList, type SelectListTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";
import { THINKING_LEVELS } from "./thinking.ts";

const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

const descriptions: Record<ModelThinkingLevel, string> = {
  off: "no reasoning",
  minimal: "very brief reasoning (~1k tokens)",
  low: "light reasoning (~2k tokens)",
  medium: "moderate reasoning (~8k tokens)",
  high: "deep reasoning (~16k tokens)",
  xhigh: "extra-high reasoning (~32k tokens)",
  max: "maximum reasoning",
};

const listTheme: SelectListTheme = {
  selectedPrefix: (text) => style.accent(text),
  selectedText: (text) => style.bold(text),
  description: (text) => style.muted(text),
  scrollInfo: (text) => style.dim(text),
  noMatch: (text) => style.dim(text),
};

export class ThinkingPicker extends Container {
  readonly capturesViewportInput = true;

  #list: SelectList;

  constructor(
    current: ModelThinkingLevel,
    onSelect: (level: ModelThinkingLevel) => void,
    onCancel: () => void,
  ) {
    super();
    this.#list = new SelectList(
      THINKING_LEVELS.map((level) => ({
        value: level,
        label: `${level === current ? "✓ " : "  "}${level}`,
        description: descriptions[level],
      })),
      THINKING_LEVELS.length,
      listTheme,
      LAYOUT,
    );
    this.#list.setSelectedIndex(Math.max(THINKING_LEVELS.indexOf(current), 0));
    this.#list.onSelect = (item) => onSelect(item.value as ModelThinkingLevel);
    this.#list.onCancel = onCancel;
    this.addChild(new Spacer(1));
    this.addChild(new Text(`${style.muted("default thinking")} ${style.accent(current)}`, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.#list);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(style.muted("  enter sets the level new conversations run at · esc closes"), 0, 0),
    );
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }
}

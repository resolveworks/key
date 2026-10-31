// The thinking picker: every level pi-ai knows, with the two defaults in view and tab between
// them.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Container,
  getKeybindings,
  SelectList,
  type SelectListLayoutOptions,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Target } from "./defaults.ts";
import { Targets } from "./targets.ts";
import { selectTheme } from "./theme.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS, type ThinkingDefaults } from "./thinking.ts";

const LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

const descriptions: Record<ModelThinkingLevel, string> = {
  off: "no reasoning",
  minimal: "very brief reasoning (~1k tokens)",
  low: "light reasoning (~2k tokens)",
  medium: "moderate reasoning (~8k tokens)",
  high: "deep reasoning (~16k tokens)",
  xhigh: "extra-high reasoning (~32k tokens)",
  max: "maximum reasoning",
};

export class ThinkingPicker extends Container {
  readonly capturesViewportInput = true;

  #tui: TUI;
  #targets: Targets<ModelThinkingLevel>;
  #header = new Text("", 0, 0);
  #hint = new Text("", 0, 0);
  #list = new SelectList(
    THINKING_LEVELS.map((level) => ({
      value: level,
      label: level,
      description: descriptions[level],
    })),
    THINKING_LEVELS.length,
    selectTheme,
    LAYOUT,
  );

  constructor(
    tui: TUI,
    defaults: ThinkingDefaults,
    target: Target,
    onSelect: (target: Target, level: ModelThinkingLevel) => void,
    onCancel: () => void,
  ) {
    super();
    this.#tui = tui;
    this.#targets = new Targets(defaults, target, (level) => level ?? DEFAULT_THINKING_LEVEL);
    this.#list.onSelect = (item) => {
      const level = THINKING_LEVELS.find((candidate) => candidate === item.value);
      if (level !== undefined) onSelect(this.#targets.target, level);
    };
    this.#list.onCancel = onCancel;
    this.addChild(new Spacer(1));
    this.addChild(this.#header);
    this.addChild(new Spacer(1));
    this.addChild(this.#list);
    this.addChild(new Spacer(1));
    this.addChild(this.#hint);
    this.#refresh();
  }

  /** Reflect a saved default in place, so one `/thinking` can set both without closing. */
  setDefault(target: Target, level: ModelThinkingLevel): void {
    this.#targets.set(target, level);
    this.#refresh();
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.input.tab")) {
      this.#targets.toggle();
      this.#refresh();
      return;
    }
    this.#list.handleInput(data);
  }

  #refresh(): void {
    this.#header.setText(this.#targets.header());
    this.#hint.setText(this.#targets.hint());
    this.#list.setSelectedIndex(
      Math.max(THINKING_LEVELS.indexOf(this.#targets.current ?? DEFAULT_THINKING_LEVEL), 0),
    );
    this.#tui.requestRender();
  }
}

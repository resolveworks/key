// The model picker: one selective list over pi's catalog, with the two defaults in
// view and tab between them. Enter sets the default the header names and stays open; escape closes.

import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ModelDefaults, ModelInfo, ModelTarget } from "./models.ts";
import { targetName } from "./models.ts";
import { style } from "./theme.ts";

const MAX_VISIBLE = 12;
const LAYOUT = { minPrimaryColumnWidth: 56, maxPrimaryColumnWidth: 56 };

const listTheme: SelectListTheme = {
  selectedPrefix: (text) => style.accent(text),
  selectedText: (text) => style.bold(text),
  description: (text) => style.muted(text),
  scrollInfo: (text) => style.dim(text),
  noMatch: (text) => style.dim(text),
};

const keyOf = (model: ModelInfo): string => `${model.provider}\u0000${model.id}`;

const searchText = ({ id, provider, name }: ModelInfo): string =>
  `${provider} ${provider}/${id} ${provider} ${id}${name === "" ? "" : ` ${name}`}`;

const label = (model: ModelInfo): string => {
  const name = model.name === "" || model.name === model.id ? "" : ` (${model.name})`;
  return `${model.id}${name} [${model.provider}]`;
};

export class ModelPicker extends Container implements Focusable {
  readonly capturesViewportInput = true;

  #target: ModelTarget;
  #models: readonly ModelInfo[];
  #defaults: ModelDefaults;
  #search = new Input({
    prompt: "  filter ",
    placeholder: "type to narrow",
    placeholderStyle: style.dim,
  });
  #defaultsText = new Text("", 0, 0);
  #hintText = new Text("", 0, 0);
  #listContainer = new Container();
  #list = new SelectList([], MAX_VISIBLE, listTheme, LAYOUT);
  #selectedKey: string | undefined;
  #tui: TUI;
  #onSelect: (target: ModelTarget, model: ModelInfo) => void;
  #onCancel: () => void;

  constructor(
    tui: TUI,
    models: readonly ModelInfo[],
    defaults: ModelDefaults,
    target: ModelTarget,
    onSelect: (target: ModelTarget, model: ModelInfo) => void,
    onCancel: () => void,
  ) {
    super();
    this.#tui = tui;
    this.#models = models;
    this.#defaults = defaults;
    this.#target = target;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new Spacer(1));
    this.addChild(this.#defaultsText);
    this.addChild(this.#search);
    this.addChild(new Spacer(1));
    this.addChild(this.#listContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.#hintText);
    this.#refresh();
  }

  get focused(): boolean {
    return this.#search.focused;
  }

  set focused(value: boolean) {
    this.#search.focused = value;
  }

  /** Reflect a saved default in place, so `/model` can set both without closing. */
  setDefault(target: ModelTarget, model: ModelInfo): void {
    const ref = { provider: model.provider, modelId: model.id };
    this.#defaults =
      target === "child"
        ? { ...this.#defaults, child: ref }
        : { ...this.#defaults, conversation: ref };
    this.#target = target;
    this.#selectedKey = keyOf(model);
    this.#refresh();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.input.tab")) {
      this.#target = this.#target === "conversation" ? "child" : "conversation";
      this.#selectedKey = undefined;
      this.#refresh();
      return;
    }
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.pageUp") ||
      kb.matches(data, "tui.select.pageDown") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.#list.handleInput(data);
      return;
    }
    this.#search.handleInput(data);
    this.#refresh();
  }

  #refresh(): void {
    const query = this.#search.getValue().trim();
    const filtered =
      query === "" ? this.#sort(this.#models) : fuzzyFilter([...this.#models], query, searchText);
    const items = filtered.map((model) => ({
      value: keyOf(model),
      label: label(model),
    }));
    const selected = filtered.findIndex((model) => keyOf(model) === this.#selectedKey);
    this.#list = new SelectList(items, MAX_VISIBLE, listTheme, LAYOUT);
    this.#list.setSelectedIndex(selected < 0 ? 0 : selected);
    this.#list.onSelectionChange = (item) => {
      this.#selectedKey = item.value;
    };
    this.#list.onSelect = (item) => {
      const [provider, id] = item.value.split("\u0000");
      const model = this.#models.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      );
      if (model !== undefined) this.#onSelect(this.#target, model);
    };
    this.#list.onCancel = () => this.#onCancel();
    this.#selectedKey = filtered.length === 0 ? undefined : keyOf(filtered[Math.max(0, selected)]);
    this.#listContainer.clear();
    this.#listContainer.addChild(
      filtered.length === 0 ? new Text(style.dim("  no matching models"), 0, 0) : this.#list,
    );
    this.#updateHeader();
    this.#tui.requestRender();
  }

  /** The target's default first, then by provider: the same shape pi's picker uses. */
  #sort(models: readonly ModelInfo[]): ModelInfo[] {
    const current = this.#defaults[this.#target];
    return [...models].sort((a, b) => {
      const aCurrent =
        current !== undefined && a.provider === current.provider && a.id === current.modelId
          ? 1
          : 0;
      const bCurrent =
        current !== undefined && b.provider === current.provider && b.id === current.modelId
          ? 1
          : 0;
      return (
        bCurrent - aCurrent || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
      );
    });
  }

  #updateHeader(): void {
    const ref = (model: { readonly provider: string; readonly modelId: string } | undefined) =>
      model === undefined ? "(unset)" : `${model.provider}/${model.modelId}`;
    this.#defaultsText.setText(
      `${style.muted("defaults")}  ${style.muted("conversations")} ${style.accent(ref(this.#defaults.conversation))}  ${style.muted("children")} ${style.accent(ref(this.#defaults.child))}`,
    );
    this.#hintText.setText(
      `${style.accent(`→ ${targetName(this.#target)}`)} ${style.muted("· tab switches · enter sets · esc closes")}`,
    );
  }
}

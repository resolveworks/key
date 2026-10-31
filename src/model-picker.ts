// The model picker: one selective list over the configured providers' models, the two defaults
// in view, tab between them.

import type { ModelRef } from "@earendil-works/pi-durable";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  type SelectListLayoutOptions,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Target } from "./defaults.ts";
import type { ModelDefaults, ModelInfo } from "./models.ts";
import { Targets } from "./targets.ts";
import { selectTheme, style } from "./theme.ts";

const MAX_VISIBLE = 12;
const LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 56, maxPrimaryColumnWidth: 56 };

const key = (provider: string, id: string): string => `${provider}\u0000${id}`;

const ref = (model: ModelInfo): ModelRef => ({ provider: model.provider, modelId: model.id });

const showModel = (model: ModelRef | undefined): string =>
  model === undefined ? "(unset)" : `${model.provider}/${model.modelId}`;

const searchText = ({ id, provider, name }: ModelInfo): string =>
  `${provider} ${provider}/${id} ${provider} ${id}${name === "" ? "" : ` ${name}`}`;

const label = (model: ModelInfo): string => {
  const name = model.name === "" || model.name === model.id ? "" : ` (${model.name})`;
  return `${model.id}${name} [${model.provider}]`;
};

export class ModelPicker extends Container implements Focusable {
  readonly capturesViewportInput = true;

  #tui: TUI;
  #models: readonly ModelInfo[];
  #targets: Targets<ModelRef>;
  #onSelect: (target: Target, model: ModelInfo) => void;
  #onCancel: () => void;
  #search = new Input({
    prompt: "  filter ",
    placeholder: "type to narrow",
    placeholderStyle: style.dim,
  });
  #header = new Text("", 0, 0);
  #hint = new Text("", 0, 0);
  #listContainer = new Container();
  #list = new SelectList([], MAX_VISIBLE, selectTheme, LAYOUT);
  #selectedKey: string | undefined;

  constructor(
    tui: TUI,
    models: readonly ModelInfo[],
    defaults: ModelDefaults,
    target: Target,
    onSelect: (target: Target, model: ModelInfo) => void,
    onCancel: () => void,
  ) {
    super();
    this.#tui = tui;
    this.#models = models;
    this.#targets = new Targets(defaults, target, showModel);
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new Spacer(1));
    this.addChild(this.#header);
    this.addChild(this.#search);
    this.addChild(new Spacer(1));
    this.addChild(this.#listContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.#hint);
    this.#refresh();
  }

  get focused(): boolean {
    return this.#search.focused;
  }

  set focused(value: boolean) {
    this.#search.focused = value;
  }

  /** Reflect a saved default in place, so one `/model` can set both without closing. */
  setDefault(target: Target, model: ModelInfo): void {
    this.#targets.set(target, ref(model));
    this.#selectedKey = key(model.provider, model.id);
    this.#refresh();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.input.tab")) {
      this.#targets.toggle();
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
    this.#header.setText(this.#targets.header());
    this.#hint.setText(this.#targets.hint("configured providers only"));
    const query = this.#search.getValue().trim();
    const current = this.#targets.current;
    const currentKey = current === undefined ? undefined : key(current.provider, current.modelId);
    const models = this.#sorted(currentKey);
    const filtered = query === "" ? models : fuzzyFilter([...models], query, searchText);
    const selected = filtered.findIndex(
      (model) => key(model.provider, model.id) === (this.#selectedKey ?? currentKey),
    );
    const index = Math.max(selected, 0);
    this.#list = new SelectList(
      filtered.map((model) => ({ value: key(model.provider, model.id), label: label(model) })),
      MAX_VISIBLE,
      selectTheme,
      LAYOUT,
    );
    this.#list.setSelectedIndex(index);
    this.#list.onSelectionChange = (item) => {
      this.#selectedKey = item.value;
    };
    this.#list.onSelect = (item) => {
      const [provider, id] = item.value.split("\u0000");
      const model = this.#models.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      );
      if (model === undefined) return;
      this.#onSelect(this.#targets.target, model);
    };
    this.#list.onCancel = () => this.#onCancel();
    const shown = filtered[index];
    this.#selectedKey = shown === undefined ? undefined : key(shown.provider, shown.id);
    this.#listContainer.clear();
    this.#listContainer.addChild(
      filtered.length === 0
        ? new Text(
            style.dim(
              query === ""
                ? "  no models from configured providers · /login adds one"
                : "  no matching models",
            ),
            0,
            0,
          )
        : this.#list,
    );
    this.#tui.requestRender();
  }

  /** The target's default first, then by provider: the same shape pi's picker uses. */
  #sorted(currentKey: string | undefined): ModelInfo[] {
    const rank = (model: ModelInfo) => (key(model.provider, model.id) === currentKey ? 1 : 0);
    return [...this.#models].sort(
      (a, b) =>
        rank(b) - rank(a) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
  }
}

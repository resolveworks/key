// The model picker: one selective list over the configured providers' models, the two defaults
// in view, tab between them.

import type { ModelRef } from "@earendil-works/pi-durable";
import {
  Container,
  type Focusable,
  getKeybindings,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Target } from "./defaults.ts";
import { FilterList } from "./filter-list.ts";
import type { ModelDefaults, ModelInfo } from "./models.ts";
import { Targets } from "./targets.ts";

const LAYOUT = { minPrimaryColumnWidth: 56, maxPrimaryColumnWidth: 56 };

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

  #targets: Targets<ModelRef>;
  #models: readonly ModelInfo[];
  #header = new Text("", 0, 0);
  #hint = new Text("", 0, 0);
  #list: FilterList<ModelInfo>;

  constructor(
    tui: TUI,
    models: readonly ModelInfo[],
    defaults: ModelDefaults,
    target: Target,
    onSelect: (target: Target, model: ModelInfo) => void,
    onCancel: () => void,
  ) {
    super();
    this.#models = models;
    this.#targets = new Targets(defaults, target, showModel);
    this.#list = new FilterList(tui, {
      keyOf: (model) => key(model.provider, model.id),
      item: (model) => ({ label: label(model) }),
      search: searchText,
      empty: (query) =>
        query === ""
          ? "no models from configured providers · /login adds one"
          : "no matching models",
      placeholder: "type to narrow",
      layout: LAYOUT,
      onSelect: (model) => onSelect(this.#targets.target, model),
      onCancel,
    });
    this.addChild(new Spacer(1));
    this.addChild(this.#header);
    this.addChild(this.#list);
    this.addChild(new Spacer(1));
    this.addChild(this.#hint);
    this.#refresh();
  }

  get focused(): boolean {
    return this.#list.focused;
  }

  set focused(value: boolean) {
    this.#list.focused = value;
  }

  /** Reflect a saved default in place, so one `/model` can set both without closing. */
  setDefault(target: Target, model: ModelInfo): void {
    this.#targets.set(target, ref(model));
    this.#list.select(key(model.provider, model.id));
    this.#refresh();
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.input.tab")) {
      this.#targets.toggle();
      this.#list.select(undefined);
      this.#refresh();
      return;
    }
    this.#list.handleInput(data);
  }

  #refresh(): void {
    this.#header.setText(this.#targets.header());
    this.#hint.setText(this.#targets.hint("configured providers only"));
    const current = this.#targets.current;
    const currentKey = current === undefined ? undefined : key(current.provider, current.modelId);
    // The target's default first, then by provider: the same shape pi's picker uses.
    const rank = (model: ModelInfo) => (key(model.provider, model.id) === currentKey ? 1 : 0);
    const sorted = [...this.#models].sort(
      (a, b) =>
        rank(b) - rank(a) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
    this.#list.rebuild(sorted);
  }
}

// One fuzzy-filtered selectable list: a filter input above a SelectList, rebuilt on change with
// the selection kept by key across the rebuild. The pickers beneath the client's overlays.

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
import { selectTheme, style } from "./theme.ts";

const MAX_VISIBLE = 12;

/** The shared column shape of the client's pickers. */
export const LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 56,
  maxPrimaryColumnWidth: 56,
};

export type FilterListOptions<T> = {
  keyOf: (item: T) => string;
  item: (item: T) => { label: string; description?: string };
  search: (item: T) => string;
  empty: (query: string) => string;
  placeholder: string;
  onSelect: (item: T) => void;
  onCancel: () => void;
};

export class FilterList<T> extends Container implements Focusable {
  readonly capturesViewportInput = true;

  #tui: TUI;
  #options: FilterListOptions<T>;
  #items: readonly T[] = [];
  #selectedKey: string | undefined;
  #filtered: readonly T[] = [];
  #search: Input;
  #listContainer = new Container();
  #list: SelectList | undefined;

  constructor(tui: TUI, options: FilterListOptions<T>) {
    super();
    this.#tui = tui;
    this.#options = options;
    this.#search = new Input({
      prompt: "  filter ",
      placeholder: options.placeholder,
      placeholderStyle: style.dim,
    });
    this.addChild(this.#search);
    this.addChild(new Spacer(1));
    this.addChild(this.#listContainer);
    this.#refresh();
  }

  get focused(): boolean {
    return this.#search.focused;
  }

  set focused(value: boolean) {
    this.#search.focused = value;
  }

  /** Point the selection at a key — or clear it, to fall back wherever the caller decides. */
  select(key: string | undefined): void {
    this.#selectedKey = key;
  }

  rebuild(items: readonly T[]): void {
    this.#items = items;
    this.#refresh();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.pageUp") ||
      kb.matches(data, "tui.select.pageDown") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.#list?.handleInput(data);
      return;
    }
    this.#search.handleInput(data);
    this.#refresh();
  }

  #refresh(): void {
    const query = this.#search.getValue().trim();
    this.#filtered =
      query === "" ? this.#items : fuzzyFilter([...this.#items], query, this.#options.search);
    const list = new SelectList(
      this.#filtered.map((item) => ({
        value: this.#options.keyOf(item),
        ...this.#options.item(item),
      })),
      MAX_VISIBLE,
      selectTheme,
      LAYOUT,
    );
    const index = Math.max(
      this.#filtered.findIndex((item) => this.#options.keyOf(item) === this.#selectedKey),
      0,
    );
    list.setSelectedIndex(index);
    list.onSelectionChange = (entry) => {
      this.#selectedKey = entry.value;
    };
    list.onSelect = (entry) => {
      const item = this.#filtered.find(
        (candidate) => this.#options.keyOf(candidate) === entry.value,
      );
      if (item !== undefined) this.#options.onSelect(item);
    };
    list.onCancel = () => this.#options.onCancel();
    this.#list = list;
    this.#selectedKey =
      this.#filtered[index] === undefined ? undefined : this.#options.keyOf(this.#filtered[index]);
    this.#listContainer.clear();
    this.#listContainer.addChild(
      this.#filtered.length === 0
        ? new Text(style.dim(`  ${this.#options.empty(query)}`), 0, 0)
        : list,
    );
    this.#tui.requestRender();
  }
}

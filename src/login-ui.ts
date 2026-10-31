// The client halves of `/login`: a picker for the provider and auth method, then a view that
// turns the host's login events into prompts and notices.

import type { AuthEvent, AuthType } from "@earendil-works/pi-ai";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { LoginEvent, LoginPrompt, ProviderInfo } from "./login.ts";
import { style } from "./theme.ts";

const MAX_VISIBLE = 12;
const LAYOUT = { minPrimaryColumnWidth: 56, maxPrimaryColumnWidth: 56 };

const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => style.accent(text),
  selectedText: (text) => style.bold(text),
  description: (text) => style.muted(text),
  scrollInfo: (text) => style.dim(text),
  noMatch: (text) => style.dim(text),
};

type Choice = { readonly provider: ProviderInfo; readonly type: AuthType };

const choices = (providers: readonly ProviderInfo[]): readonly Choice[] =>
  providers.flatMap((provider) => [
    ...(provider.oauth?.login === true ? [{ provider, type: "oauth" as const }] : []),
    ...(provider.apiKey?.login === true ? [{ provider, type: "api_key" as const }] : []),
  ]);

const keyOf = (choice: Choice): string => `${choice.provider.id}\u0000${choice.type}`;

const methodName = (choice: Choice): string =>
  choice.type === "oauth"
    ? (choice.provider.oauth?.label ?? choice.provider.oauth?.name ?? "account")
    : (choice.provider.apiKey?.name ?? "API key");

const choiceLabel = (choice: Choice): string =>
  `${choice.provider.name} · ${choice.type === "oauth" ? "account" : "API key"}`;

const choiceDescription = (choice: Choice): string => {
  const source = choice.provider.status?.source;
  const configured =
    choice.provider.status === undefined
      ? "not configured"
      : `configured${source === undefined ? "" : ` · ${source}`}`;
  return `${methodName(choice)} · ${configured}`;
};

const searchText = (choice: Choice): string =>
  `${choice.provider.name} ${choice.provider.id} ${
    choice.type === "oauth" ? "account oauth" : "api key api_key"
  }`;

export class LoginPicker extends Container implements Focusable {
  readonly capturesViewportInput = true;

  #choices: readonly Choice[];
  #search = new Input({
    prompt: "  filter ",
    placeholder: "provider or method",
    placeholderStyle: style.dim,
  });
  #hint = new Text("", 0, 0);
  #listContainer = new Container();
  #list = new SelectList([], MAX_VISIBLE, selectTheme, LAYOUT);
  #selectedKey: string | undefined;
  #tui: TUI;
  #onSelect: (provider: ProviderInfo, type: AuthType) => void;
  #onCancel: () => void;

  constructor(
    tui: TUI,
    providers: readonly ProviderInfo[],
    onSelect: (provider: ProviderInfo, type: AuthType) => void,
    onCancel: () => void,
  ) {
    super();
    this.#tui = tui;
    this.#choices = choices(providers);
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new Spacer(1));
    this.addChild(new Text(style.muted("login · choose a provider and method"), 0, 0));
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
      this.#list.handleInput(data);
      return;
    }
    this.#search.handleInput(data);
    this.#refresh();
  }

  #refresh(): void {
    const query = this.#search.getValue().trim();
    const filtered =
      query === "" ? this.#choices : fuzzyFilter([...this.#choices], query, searchText);
    const items = filtered.map((choice) => ({
      value: keyOf(choice),
      label: choiceLabel(choice),
      description: choiceDescription(choice),
    }));
    const selected = filtered.findIndex((choice) => keyOf(choice) === this.#selectedKey);
    this.#list = new SelectList(items, MAX_VISIBLE, selectTheme, LAYOUT);
    this.#list.setSelectedIndex(Math.max(selected, 0));
    this.#list.onSelectionChange = (item) => {
      this.#selectedKey = item.value;
    };
    this.#list.onSelect = (item) => {
      const choice = filtered.find((candidate) => keyOf(candidate) === item.value);
      if (choice !== undefined) this.#onSelect(choice.provider, choice.type);
    };
    this.#list.onCancel = () => this.#onCancel();
    this.#selectedKey = filtered.length === 0 ? undefined : keyOf(filtered[Math.max(0, selected)]);
    this.#listContainer.clear();
    this.#listContainer.addChild(
      filtered.length === 0 ? new Text(style.dim("  no matching providers"), 0, 0) : this.#list,
    );
    this.#hint.setText(style.muted("enter starts · esc closes"));
    this.#tui.requestRender();
  }
}

export class LoginView extends Container implements Focusable {
  readonly capturesViewportInput = true;

  #tui: TUI;
  #notices = new Container();
  #promptContainer = new Container();
  #input: Input | undefined;
  #list: SelectList | undefined;
  #promptId: number | undefined;
  #secret = false;
  #lastSeq = 0;
  #finished = false;
  #focused = false;
  #onAnswer: (id: number, value: string) => void;
  #onCancel: () => void;
  #onFinish: (message?: string) => void;

  constructor(
    tui: TUI,
    provider: ProviderInfo,
    type: AuthType,
    onAnswer: (id: number, value: string) => void,
    onCancel: () => void,
    onFinish: (message?: string) => void,
  ) {
    super();
    this.#tui = tui;
    this.#onAnswer = onAnswer;
    this.#onCancel = onCancel;
    this.#onFinish = onFinish;
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        `${style.accent("login")} ${style.muted(`· ${provider.name} · ${type === "oauth" ? "account" : "API key"}`)}`,
        0,
        0,
      ),
    );
    this.addChild(this.#notices);
    this.addChild(this.#promptContainer);
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    if (this.#input !== undefined) this.#input.focused = value;
  }

  /** Apply one host event, ignoring anything already seen before a reconnect. */
  apply(event: LoginEvent): void {
    if (event.seq <= this.#lastSeq) return;
    this.#lastSeq = event.seq;
    switch (event.kind) {
      case "prompt":
        this.#showPrompt(event.id, event.prompt);
        break;
      case "notice":
        this.#notice(event.event);
        break;
      case "done":
        this.#finish();
        break;
      case "failed":
        this.#finish(event.message);
        break;
    }
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    if (matchesKey(data, "ctrl+c")) {
      this.#onCancel();
      return;
    }
    if (this.#list !== undefined) {
      this.#list.handleInput(data);
      return;
    }
    if (this.#input !== undefined) {
      this.#input.handleInput(data);
      return;
    }
    if (getKeybindings().matches(data, "tui.select.cancel")) this.#onCancel();
  }

  #showPrompt(id: number, prompt: LoginPrompt): void {
    this.#promptId = id;
    this.#secret = prompt.type === "secret";
    this.#input = undefined;
    this.#list = undefined;
    this.#promptContainer.clear();
    this.#promptContainer.addChild(new Spacer(1));
    this.#promptContainer.addChild(new Text(style.text(prompt.message), 0, 0));

    if (prompt.type === "select") {
      const list = new SelectList(
        prompt.options.map((option) => ({
          value: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        Math.max(1, Math.min(prompt.options.length, MAX_VISIBLE)),
        selectTheme,
        LAYOUT,
      );
      list.onSelect = (item) => this.#answer(item.value);
      list.onCancel = () => this.#onCancel();
      this.#list = list;
      this.#promptContainer.addChild(list);
    } else {
      if (prompt.placeholder !== undefined)
        this.#promptContainer.addChild(new Text(style.dim(`  e.g. ${prompt.placeholder}`), 0, 0));
      const input = new Input({
        prompt: "  ",
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
        placeholderStyle: style.dim,
      });
      input.focused = this.#focused;
      input.onSubmit = (value) => this.#answer(value);
      input.onEscape = () => this.#onCancel();
      this.#input = input;
      this.#promptContainer.addChild(input);
    }
    this.#promptContainer.addChild(new Text(style.dim("  enter submits · esc cancels"), 0, 0));
  }

  #answer(value: string): void {
    const id = this.#promptId;
    if (id === undefined) return;
    const shown = this.#secret ? "••••••" : value;
    this.#promptId = undefined;
    this.#input = undefined;
    this.#list = undefined;
    this.#promptContainer.clear();
    this.#promptContainer.addChild(new Spacer(1));
    this.#promptContainer.addChild(new Text(style.dim(`  > ${shown}`), 0, 0));
    this.#onAnswer(id, value);
    this.#tui.requestRender();
  }

  #notice(event: AuthEvent): void {
    switch (event.type) {
      case "info":
        this.#line(event.message);
        for (const link of event.links ?? [])
          this.#line(
            link.label === undefined ? link.url : `${link.label}: ${link.url}`,
            style.accent,
          );
        break;
      case "auth_url":
        this.#line(`Open ${event.url}`, style.accent);
        if (event.instructions !== undefined) this.#line(event.instructions);
        break;
      case "device_code":
        this.#line(`Open ${event.verificationUri}`, style.accent);
        this.#line(`Enter code: ${event.userCode}`, style.bold);
        break;
      case "progress":
        this.#line(event.message, style.dim);
        break;
    }
  }

  #line(text: string, paint: (text: string) => string = style.text): void {
    this.#notices.addChild(new Spacer(1));
    this.#notices.addChild(new Text(paint(text), 0, 0));
  }

  #finish(message?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#promptId = undefined;
    this.#input = undefined;
    this.#list = undefined;
    this.#promptContainer.clear();
    if (message !== undefined) this.#line(message, style.error);
    this.#onFinish(message);
  }
}

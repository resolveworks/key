// pi's dark theme, expressed as style functions. Built on `styleTextWithAnsi`, which opens every
// attribute it is given and closes all of them, so a token nests inside another.
import {
	backgroundAnsi,
	type Color,
	foregroundAnsi,
	getTerminalColorMode,
	type MarkdownTheme,
	okhslColor,
	parseColor,
	styleTextWithAnsi,
	type TextAttributes,
} from "@earendil-works/pi-tui";

const mode = getTerminalColorMode();
const hex = (value: string): Color => parseColor(value);

/** pi's dark foreground palette. */
const fg = {
	accent: hex("#b281d6"),
	border: hex("#7681c8"),
	success: hex("#68d391"),
	error: hex("#f08c66"),
	warning: hex("#d6d94e"),
	muted: okhslColor(229, 0.06, 0.67),
	dim: okhslColor(229, 0.08, 0.56),
	thinking: okhslColor(226, 0.07, 0.65),
	mdHeading: hex("#d6d94e"),
	mdLink: hex("#88a2e8"),
	mdCode: hex("#b281d6"),
	mdCodeBlock: hex("#68d391"),
	mdListBullet: hex("#b281d6"),
	diffAdded: hex("#68d391"),
	diffRemoved: hex("#f08c66"),
	scrollbarTrack: okhslColor(237, 0.07, 0.33),
	scrollbarThumb: okhslColor(232, 0.07, 0.65),
} as const;

/** pi's dark background palette. */
const bg = {
	user: hex("#2b3553"),
	selected: hex("#2b3553"),
	toolPending: okhslColor(229, 0.05, 0.24),
	toolSuccess: okhslColor(158, 0.46, 0.25),
	toolError: okhslColor(19, 0.54, 0.25),
} as const;

/** A style is just the function that paints text with it, so styles compose like any other decorator. */
type Style = (text: string) => string;
type Attributes = TextAttributes;

/** A color in the foreground; undefined means the terminal's own default. */
function on(color: Color | undefined, attributes: Attributes = {}): Style {
	const prefix = color === undefined ? undefined : foregroundAnsi(color, mode);
	return (value) => styleTextWithAnsi(value, prefix, undefined, attributes);
}

/** A color behind the text, padded by the component that draws it. */
function behind(color: Color | undefined): Style {
	const prefix = color === undefined ? undefined : backgroundAnsi(color, mode);
	return (value) => styleTextWithAnsi(value, undefined, prefix, {});
}

export const style = {
	text: on(undefined),
	muted: on(fg.muted),
	dim: on(fg.dim),
	accent: on(fg.accent),
	border: on(fg.border),
	success: on(fg.success),
	error: on(fg.error),
	warning: on(fg.warning),
	bold: on(undefined, { bold: true }),
	italic: on(undefined, { italic: true }),
	underline: on(undefined, { underline: true }),
	inverse: on(undefined, { inverse: true }),
	thinking: on(fg.thinking, { italic: true }),
	toolOutput: on(fg.muted),
	userBg: behind(bg.user),
	toolBg: {
		pending: behind(bg.toolPending),
		success: behind(bg.toolSuccess),
		error: behind(bg.toolError),
	},
	scrollbar: { track: on(fg.scrollbarTrack), thumb: on(fg.scrollbarThumb) },
} as const;

/** Named combinations, so call sites read as the pi they imitate. */
export const bold = (color: Color | undefined, value: string): string =>
	style.bold(on(color)(value));

/** pi's markdown theme: headings, links, code, quotes and bullets each carry their own color. */
export const markdown: MarkdownTheme = {
	heading: (value) => bold(fg.mdHeading, value),
	link: (value) => style.underline(on(fg.mdLink)(value)),
	linkUrl: (value) => style.muted(value),
	code: (value) => on(fg.mdCode)(value),
	codeBlock: (value) => on(fg.mdCodeBlock)(value),
	codeBlockBorder: (value) => style.muted(value),
	quote: (value) => style.muted(value),
	quoteBorder: (value) => style.muted(value),
	hr: (value) => style.muted(value),
	listBullet: (value) => on(fg.mdListBullet)(value),
	bold: (value) => style.bold(value),
	italic: (value) => style.italic(value),
	underline: (value) => style.underline(value),
	strikethrough: (value) => on(undefined, { strikethrough: true })(value),
};

/** Diff lines: added green, removed red, context muted, as pi draws an edit's result. */
export const diff = {
	added: on(fg.diffAdded),
	removed: on(fg.diffRemoved),
	context: on(fg.muted),
};

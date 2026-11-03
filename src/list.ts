// The shared selectable list: one theme and column shape beneath the client's pickers.

import { type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { selectTheme } from "./theme.ts";

export const LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 56,
  maxPrimaryColumnWidth: 56,
};

export function selectList(
  items: SelectItem[],
  maxVisible: number,
  layout: SelectListLayoutOptions = LAYOUT,
): SelectList {
  return new SelectList(items, maxVisible, selectTheme, layout);
}

// The two thinking defaults: what a conversation starts on, and what the children it spawns run on.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Defaults } from "./defaults.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What each target runs at until `/thinking` says otherwise; a model without thinking clamps
 * it to `off`. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "high";

export type ThinkingDefaults = Defaults<ModelThinkingLevel>;

export const ThinkingDefaultsDoc = defineDoc<ThinkingDefaults>({
  kind: "key.thinking",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Changed rarely and tiny: store each change as a base, never a long delta chain.
  checkpointWhen: () => true,
});

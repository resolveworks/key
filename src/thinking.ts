// The thinking level new conversations run at, stored on the session like the model defaults.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";

/** Every level pi-ai knows, weakest first: what `/thinking` lists. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What a conversation runs at until `/thinking` says otherwise; a model without thinking clamps
 * it to `off`. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "high";

/** `/thinking`'s choice; absent means the default above. */
export type ThinkingDefault = { level?: ModelThinkingLevel };

export const ThinkingDefaultDoc = defineDoc<ThinkingDefault>({
  kind: "key.thinking",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Changed rarely and tiny: store each change as a base, never a long delta chain.
  checkpointWhen: () => true,
});

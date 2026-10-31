// The two model defaults: what a conversation starts on, and what the children it spawns run on.

import { defineDoc, type ModelRef } from "@earendil-works/pi-durable";
import type { Defaults } from "./defaults.ts";

/** The two choices `/model` stores; an absent one is unset, never inherited from the environment. */
export type ModelDefaults = Defaults<ModelRef>;

export type ModelInfo = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
};

export const ModelDefaultsDoc = defineDoc<ModelDefaults>({
  kind: "key.models",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Changed rarely and tiny: store each change as a base, never a long delta chain.
  checkpointWhen: () => true,
});

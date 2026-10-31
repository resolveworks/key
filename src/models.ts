// The two model defaults: what a conversation starts on, and what the children it spawns run on.

import { defineDoc, type ModelRef } from "@earendil-works/pi-durable";

/** Which default `/model` edits: an ownerless conversation, or any conversation a task owns. */
export type ModelTarget = "conversation" | "child";

/** The two choices `/model` stores; an absent one is unset, never inherited from the environment. */
export type ModelDefaults = {
  conversation?: ModelRef;
  child?: ModelRef;
};

/** One catalog model, as the picker lists it. */
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

/** What a target is called where the user reads it. */
export function targetName(target: ModelTarget): string {
  return target === "child" ? "children" : "conversations";
}

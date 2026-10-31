// The seen marks: which conversations' stops a human has already looked at.

import { defineDoc } from "@earendil-works/pi-durable";

/** The conversations whose current stop has been looked at. A mark belongs to the stop it
 * silenced: the cascade moving on retires it, so the next stop flags. */
export const SeenDoc = defineDoc<{ seen: number[] }>({
  kind: "key.seen",
  version: 1,
  scope: "session",
  initial: () => ({ seen: [] }),
  // Changed rarely and tiny: store each change as a base, never a long delta chain.
  checkpointWhen: () => true,
});

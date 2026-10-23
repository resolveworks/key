import { defineEntry } from "@earendil-works/pi-durable";

/**
 * Where an interrupt landed: the transcript's own record that a context parked here, so the pause
 * says who made it even when the run had nothing to show yet.
 */
export const InterruptEntry = defineEntry("key.interrupt");

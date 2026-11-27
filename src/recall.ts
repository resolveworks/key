// The bundled guide sits at the package root: src/recall.ts and dist/recall.js alike are one level below it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RECALL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "recall");
export const RECALL_GUIDE = join(RECALL_DIR, "RECALL.md");

/** What the guide answers, kept beside the path so the prompt names one file and no catalog. */
export const RECALL = `Questions about what was discussed, decided, or tried before — "what did we do about X", "find the conversation where…", "what were we working on" — live in key's session store. Read ${RECALL_GUIDE} for how: it names the script that lists conversations, renders a transcript, and searches every entry.`;

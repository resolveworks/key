// The prompt's completions: slash commands and path completion on tab, plus @file suggestions
// through fd. This only supplies the commands key actually has.

import { spawnSync } from "node:child_process";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";

const commands: SlashCommand[] = [
  { name: "resume", description: "list past conversations" },
  { name: "new", description: "abandon the open transcript; the next prompt starts fresh" },
];

/** fd walks gitignored trees fast; without it tab still edits the line, and @ completes nothing. */
const fd = spawnSync("fd", ["--version"], { stdio: "ignore" }).status === 0 ? "fd" : null;

export const provider = (base: string) => new CombinedAutocompleteProvider(commands, base, fd);

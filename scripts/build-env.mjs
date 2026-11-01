// Build the linked pi-env package and put its daemon where localDaemon() looks.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("tsc", ["-p", "../pi/packages/env/tsconfig.build.json"]);
run("cargo", ["build", "--manifest-path", "../pi/packages/env/daemon/Cargo.toml", "--locked"]);

const { localDaemon } = await import("@earendil-works/pi-env");
const binary = localDaemon();
mkdirSync(dirname(binary), { recursive: true });
copyFileSync(
  `../pi/packages/env/daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`,
  binary,
);

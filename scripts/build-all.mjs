// Build every workspace package that has a `build` script, excluding the
// _shared library (which is consumed as TypeScript source directly via
// pnpm workspace symlinks). Fails fast on first error.

import { execSync } from "node:child_process";

execSync(
  `pnpm -r --filter "./packages/*" --filter "!@tupiflow-plugins/shared" build`,
  { stdio: "inherit" }
);

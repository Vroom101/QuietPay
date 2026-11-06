#!/usr/bin/env tsx
import { runCli } from "./run.js";
import { makeVerifierSource } from "./source.js";

// `pnpm --filter @quietpay/verifier cli ...` runs in the package directory; resolve relative paths from where the
// user typed the command (pnpm sets INIT_CWD to it).
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

runCli(process.argv.slice(2), {
  makeSource: makeVerifierSource,
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
})
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  });

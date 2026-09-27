#!/usr/bin/env node
/**
 * The `obsidian-e2e` executable. A dedicated entry (never re-exported from the
 * `obsidian-e2e/runner` barrel) so the bundler keeps this file's top-level
 * invocation in the bin chunk instead of hoisting it into shared code where it
 * would never run. All logic lives in {@link runObsidianE2ECli}; this only wires
 * argv, the exit code, and the top-level error message.
 */
import process from "node:process";

import { commandErrorMessage } from "../core/errors";
import { runObsidianE2ECli } from "./cli";

/**
 * Capture commands and signal-cancelled runs (128+n) must not linger on a
 * socket whose peer is unresponsive (a WebSocket close handshake to a frozen
 * app). The timer is unref'd, so it only fires if something else is still
 * holding the process open.
 */
function exitGuard(code: number): void {
  if (code >= 128 || process.argv[2] === "capture") {
    setTimeout(() => process.exit(code), 2000).unref();
  }
}

runObsidianE2ECli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    exitGuard(code);
  })
  .catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`${commandErrorMessage(error)}\n`);
    exitGuard(1);
  });

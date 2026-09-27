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

runObsidianE2ECli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    // A signal-cancelled run (128+n) must not linger on a socket whose peer is
    // unresponsive (e.g. a WebSocket close handshake to a frozen app).
    if (code >= 128) setTimeout(() => process.exit(code), 2000).unref();
  })
  .catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`${commandErrorMessage(error)}\n`);
  });

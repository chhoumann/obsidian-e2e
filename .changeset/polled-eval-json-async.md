---
"obsidian-e2e": minor
---

`evalJsonAsync` no longer holds a single CLI command open for the lifetime of
the awaited promise (#21). The `obsidian eval` command's reply is the only
carrier of the result, so a client timeout kill or a renderer reload mid-eval
lost the value forever even when the operation itself completed (reproduced
against the real CLI socket: a vault reload mid-eval orphans the pending
`executeJavaScript` promise and the CLI hangs indefinitely).

`evalJsonAsync` now runs a kickoff-and-poll protocol: a short kickoff command,
sent exactly once, starts the operation and records its eventual
`{ ok, value }` envelope under a per-operation nonce inside the app, and short
idempotent poll reads retrieve it. A lost reply is recovered by reading again;
the kickoff is never resent, so the evaluated code cannot run twice.
`timeoutMs` is now the overall deadline for the awaited result, with each
internal CLI command on its own short budget. Consumer-suite fire-and-poll
workarounds (window global + short `evalJson` reads) are obsolete.

Irrecoverable states throw the new `DevEvalAsyncError` whose `reason` names
the precise transport state - `ambiguous-delivery`, `context-reset`, or
`still-pending` - instead of a generic 30s timeout. The transport now throws a
typed `ObsidianCommandTimeoutError` on command timeouts, and the error classes
(`DevEvalError`, `DevEvalAsyncError`, `ObsidianCommandError`,
`ObsidianCommandTimeoutError`, `WaitForTimeoutError`) are exported from the
package root.

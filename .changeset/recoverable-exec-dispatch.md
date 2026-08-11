---
"obsidian-e2e": minor
---

`exec()` no longer hangs for the full transport timeout when the Obsidian
CLI's single-shot reply is lost (#25). Every CLI reply crosses the app's
main-to-renderer `executeJavaScript` bridge exactly once, and that bridge
loses or delays messages under suite load (reproduced live: a `plugin:reload`
completed in-app in 11ms and its reply never arrived; an eval request was
delayed 13.7s while neighboring commands were instant). Obsidian's CLI server
has no timeout or retry around the bridge, so a lost reply stalled the client
until the 30s transport kill and flaked consumer suites.

`exec()` now runs a recoverable dispatch protocol: a one-time shim wrapped
around the in-app CLI dispatcher intercepts a synthetic dispatch verb whose
payload carries the real command argv, a per-call nonce, and the shim
generation. The shim records the reply under the nonce before dispatching,
dedups repeated nonces, and refuses payloads pinned to a previous generation,
so lost replies are recovered by short idempotent polls and recovery can never
double-execute a non-idempotent command (`quickadd:run` stays exactly-once).
Handlers see their exact original argv; recovered results are byte-identical
to the direct CLI output. Everything built on `exec()` - `dev.eval`,
`dev.evalJson`, `command(id).run()`, `plugin(id).reload()` - gains the same
recovery automatically.

On the recoverable path `timeoutMs` is now the overall deadline for the
command's result rather than a single process budget. Context-destroying verbs
(`reload`, `restart`, `plugins:restrict`, `dev:mobile`) and custom transports
keep the direct single-shot path; `ExecOptions.recoverable` overrides either
default. Irrecoverable states throw the new `ObsidianCommandDispatchError`
whose `reason` names the precise transport state (`ambiguous-delivery`,
`context-reset`, `still-pending`, `undelivered`), exported from the package
root.

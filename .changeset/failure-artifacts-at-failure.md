---
"obsidian-e2e": minor
---

Failure artifacts now show the state at the moment a test failed.

- `createPluginHarness()` captures as soon as the test body fails. Before, it
  captured from `onTestFailed`, which Vitest runs after `afterEach` hooks,
  fixture teardown and `onTestFinished`, so the screenshot, `dom.txt` and plugin
  data showed the state after the test's own cleanup and the harness's data
  restore.
- `createObsidianTest()` and `createPluginTest()` never wrote artifacts, because
  their fixture teardown ran before `onTestFailed` marked the test as failed.
  They now capture during fixture teardown.
- New `registerFailureArtifacts(ctx, obsidian, options, plugin?)` from
  `obsidian-e2e/vitest` gives hand-rolled `beforeEach` lifecycles the same early
  capture.
- `dom.txt` covers the whole `document.body` instead of `.workspace`, so modals
  and notices are included. Scripts and SVG paths are dropped, input values other
  than passwords are kept, and each tag starts a line.
- `notices.json` is now `{ visible, raised }`: the notices on screen, and the
  notices raised since diagnostics were last reset.
- `dev.notices()`, `dev.diagnostics()` and `waitForNotice()` now record notices
  raised by plugins. They used to replace the `window.Notice` global, which
  plugin code never reaches: plugins construct the `Notice` exported by the
  `"obsidian"` module. Notices are now read from the DOM, so `DevNoticeEvent.timeout`
  is no longer set.

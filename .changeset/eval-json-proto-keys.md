---
"obsidian-e2e": patch
---

`evalJson` and `evalJsonAsync` now keep an own `__proto__` key in a result as a plain data key. `evalJson` used to drop it, and `evalJsonAsync` timed out with reason `still-pending` although the operation had finished. The decoded result still has `Object.prototype` as its prototype, so the key cannot pollute any prototype. A poll read that fails inside Obsidian now throws its `DevEvalError` at once.

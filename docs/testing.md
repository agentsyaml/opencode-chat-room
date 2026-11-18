# Testing notes

## Simulate scrolling with real input

Never write `scrollTop` in a test to stand in for a reader scrolling. A programmatic
write produces no wheel, touch, key, or pointer event, so the UI cannot tell it apart
from its own layout corrections:

- a reader who is following the newest messages keeps following, and the test measures a
  position the UI would have left anyway;
- paging older history never triggers;
- a test can pass on behaviour no reader can produce, and fail once the real input path
  changes.

Send the reader's own input instead:

```ts
await page.mouse.move(x, y);
await page.mouse.wheel(0, -800);          // wheel
await page.keyboard.press("PageUp");      // keys
await page.touchscreen.tap(x, y);         // touch
```

Programmatic writes are fine when the test is not pretending to be a reader, for example
placing a fixture row before reading a layout metric — say so in a comment when you do it.

## Isolate tests from real rooms

`bunfig.toml` preloads `scripts/test-env.ts` for every `bun test` run from the repository
root. A top-level run deletes inherited `CHAT_ROOM_*` variables, points `HOME`, XDG paths
and `CHAT_ROOM_STATE_DIR` at a temporary sandbox, sets `BUN_OPTIONS=--no-env-file`, and
rejects environment-configured center or wake URLs other than empty values or reserved
`.invalid` / `.example` hosts. Tests that need a local fake center pass its allocated
origin directly instead of putting loopback into the environment. Spawned Bun servers
keep the same isolation and cannot autoload a live `.env`.

Do not weaken this preload, and do not add a test that passes a real center URL to a
spawned server. Use `bun run test`, which runs each file in its own process; passing
several files to one ad-hoc `bun test` call does not isolate their module caches. The
sandbox removes its temporary directories in `afterAll`; a crashed run may leave a
directory under the OS temp root, which is safe to delete.
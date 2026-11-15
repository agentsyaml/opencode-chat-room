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
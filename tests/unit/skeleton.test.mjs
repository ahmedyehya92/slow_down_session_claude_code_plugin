import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 1 harness guard (T002): keeps `npm test` green and meaningful from
// the first commit — proves node:test discovery + ESM wiring work before any
// real tests land (T006/T007+). Remove if it ever collides with real suites.
test("test harness is wired (ESM + node:test discovery)", () => {
  assert.equal(typeof test, "function");
});

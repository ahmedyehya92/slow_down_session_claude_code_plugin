import { test } from "node:test";
import assert from "node:assert/strict";

import { computePhase } from "../../scripts/pacing.mjs";

// T006 — User Story 1 (FR-001/FR-002/FR-002a/FR-011/FR-010a).
// Pure state machine tests per data-model §3 transition table. `computePhase`
// is a pure function of (state, config, now): `now` is the injectable time
// source, so the default 5/4-minute schedule is exercised in milliseconds
// without any real-time waiting (research R6).

// Default schedule (FR-002) in milliseconds.
const WORK_MS = 5 * 60_000;
const PAUSE_MS = 4 * 60_000;
const CYCLE_MS = WORK_MS + PAUSE_MS;

// Fixed synthetic epoch for every case — phase math must not depend on the
// real clock.
const T0 = 1_700_000_000_000;

const CONFIG = { workMs: WORK_MS, pauseMs: PAUSE_MS };

/** Minimal state parcel; only `cycleStartedAt` matters to computePhase. */
function stateAt(cycleStartedAt) {
  return { sessionId: "test-session", enabled: true, phase: "work", cycleStartedAt };
}

function phaseAt(cycleStartedAt, now) {
  return computePhase(stateAt(cycleStartedAt), CONFIG, now);
}

test("elapsed < workMs → phase 'work', remaining = work − elapsed (FR-001/FR-011)", () => {
  const r = phaseAt(T0, T0); // elapsed 0
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS);
  assert.equal(r.nextCycleStartedAt, T0);

  const mid = phaseAt(T0, T0 + WORK_MS / 2);
  assert.equal(mid.phase, "work");
  assert.equal(mid.remainingMs, WORK_MS / 2);
  assert.equal(mid.nextCycleStartedAt, T0);
});

test("work boundary: elapsed just below workMs stays in work with 1 ms remaining", () => {
  const r = phaseAt(T0, T0 + WORK_MS - 1);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, 1);
});

test("elapsed == workMs → pause begins, full pause remaining (work/pause boundary)", () => {
  const r = phaseAt(T0, T0 + WORK_MS);
  assert.equal(r.phase, "pause");
  assert.equal(r.remainingMs, PAUSE_MS);
  assert.equal(r.nextCycleStartedAt, T0);
});

test("mid-pause → phase 'pause' with correct remaining pause ms", () => {
  const r = phaseAt(T0, T0 + WORK_MS + PAUSE_MS / 2);
  assert.equal(r.phase, "pause");
  assert.equal(r.remainingMs, PAUSE_MS / 2);
  assert.equal(r.nextCycleStartedAt, T0);
});

test("pause boundary: elapsed just below one full cycle → pause with 1 ms remaining", () => {
  const r = phaseAt(T0, T0 + CYCLE_MS - 1);
  assert.equal(r.phase, "pause");
  assert.equal(r.remainingMs, 1);
});

test("elapsed == one full cycle → work of the next cycle, cycleStartedAt advanced exactly one cycle (FR-011)", () => {
  const r = phaseAt(T0, T0 + CYCLE_MS);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS);
  assert.equal(r.nextCycleStartedAt, T0 + CYCLE_MS);
});

test("just past one full cycle → fresh work phase, boundary stays anchored one cycle ahead", () => {
  const r = phaseAt(T0, T0 + CYCLE_MS + 5_000);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS - 5_000);
  assert.equal(r.nextCycleStartedAt, T0 + CYCLE_MS);
});

test("idle across multiple full cycles: continuous timer consumes them all (FR-011)", () => {
  // 2 full cycles + half a work phase have elapsed while no hook ran.
  const r = phaseAt(T0, T0 + 2 * CYCLE_MS + WORK_MS / 2);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS / 2);
  assert.equal(r.nextCycleStartedAt, T0 + 2 * CYCLE_MS);

  // Same idle rule when the landed offset falls inside a pause.
  const p = phaseAt(T0, T0 + 2 * CYCLE_MS + WORK_MS + PAUSE_MS / 2);
  assert.equal(p.phase, "pause");
  assert.equal(p.remainingMs, PAUSE_MS / 2);
  assert.equal(p.nextCycleStartedAt, T0 + 2 * CYCLE_MS);
});

test("work-phase overrun is tolerated: a late Stop fires the pause with real remaining (FR-002a)", () => {
  // Task overran the 5-minute work window by 1 minute; the pause must begin
  // only now that the task finished — with the remaining pause computed from
  // the wall clock, not a stale 4-minute timer.
  const r = phaseAt(T0, T0 + WORK_MS + 60_000);
  assert.equal(r.phase, "pause");
  assert.equal(r.remainingMs, PAUSE_MS - 60_000);
});

test("FR-010a: hook aborted mid-pause (no post-sleep write) → next run recomputes a fresh work phase", () => {
  // Run 1 would have slept from T0 + workMs + 1s (mid-pause) but was killed
  // before any state write. Run 2 happens well past the cycle end.
  const abortedAt = T0 + WORK_MS + 1_000;
  assert.equal(phaseAt(T0, abortedAt).phase, "pause");

  const later = T0 + CYCLE_MS + 2_000;
  const r = phaseAt(T0, later);
  assert.equal(r.phase, "work"); // stale pause must NOT survive recomputation
  assert.equal(r.remainingMs, WORK_MS - 2_000);
  assert.equal(r.nextCycleStartedAt, later - 2_000);
});

test("determinism: identical inputs yield identical outputs (±2 s schedule tolerance)", () => {
  const inputs = [
    [T0, T0],
    [T0, T0 + WORK_MS / 2],
    [T0, T0 + WORK_MS],
    [T0, T0 + WORK_MS + 42_000],
    [T0, T0 + CYCLE_MS],
    [T0, T0 + 3 * CYCLE_MS + WORK_MS + 1_000],
  ];
  for (const [start, now] of inputs) {
    const a = phaseAt(start, now);
    const b = phaseAt(start, now);
    assert.deepEqual(a, b, `inputs (${start}, ${now}) must be reproducible`);
  }

  // Phase boundaries are stable within a 2 s scheduling tolerance: staying
  // inside the same 2 s window must not flip the phase across repeats.
  const edgeA = phaseAt(T0, T0 + WORK_MS - 2_000);
  const edgeB = phaseAt(T0, T0 + WORK_MS - 2_000);
  assert.deepEqual(edgeA, edgeB);
  assert.equal(edgeA.phase, "work");
});

test("future-dated anchor (within one cycle) clamps: work phase, full work remaining, no rebase (review S2)", () => {
  // Anchor 2 min ahead of `now` — e.g. a boundary persisted just ahead of a
  // frozen test clock, or a small backwards clock step. Without the clamp,
  // negative elapsed inflates remainingMs beyond workMs.
  const anchor = T0 + 120_000;
  const r = phaseAt(anchor, T0);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS, "remainingMs must not exceed the phase length");
  assert.equal(r.nextCycleStartedAt, anchor, "anchor must be left untouched");
});

test("future-dated anchor beyond one cycle never rebases backwards (review S2)", () => {
  // A >1-cycle clock regression would previously let the work-branch rebase
  // move cycleStartedAt backwards by a full cycle.
  const anchor = T0 + 2 * CYCLE_MS + 60_000;
  const r = phaseAt(anchor, T0);
  assert.equal(r.phase, "work");
  assert.equal(r.remainingMs, WORK_MS);
  assert.equal(r.nextCycleStartedAt, anchor, "must not move the boundary backwards");
});

test("non-default durations are honored (config is threaded, not hard-coded 5/4) (FR-005)", () => {
  const cfg = { workMs: 120_000, pauseMs: 60_000 };
  const st = stateAt(T0);

  const midWork = computePhase(st, cfg, T0 + 60_000);
  assert.equal(midWork.phase, "work");
  assert.equal(midWork.remainingMs, 60_000);

  const midPause = computePhase(st, cfg, T0 + 130_000);
  assert.equal(midPause.phase, "pause");
  assert.equal(midPause.remainingMs, 60_000 - 10_000);

  const nextCycle = computePhase(st, cfg, T0 + 180_000);
  assert.equal(nextCycle.phase, "work");
  assert.equal(nextCycle.nextCycleStartedAt, T0 + 180_000);
});
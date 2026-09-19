import { test } from "node:test";
import assert from "node:assert/strict";

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// T007 — User Story 1, black-box part 1.
// Drives the real hook binary (scripts/pacing.mjs) as a subprocess via
// spawnSync — the exact surface Claude Code invokes for the Stop hook
// (contract plugin-surface §3). Asserts the binary contract: exit status 0,
// empty stdout AND stderr (FR-004 Model Silence), near-instant no-ops for the
// short-circuit paths, and the real wall-clock pause scaled down by the
// SLOW_DOWN_TIME_SCALE test seam.

const HOOK_PATH = fileURLToPath(new URL("../../scripts/pacing.mjs", import.meta.url));

// Default schedule (FR-002) in milliseconds.
const WORK_MS = 5 * 60_000;
const PAUSE_MS = 4 * 60_000;
const CYCLE_MS = WORK_MS + PAUSE_MS;

// Test seams (contract §3) — honored only because NODE_ENV=test:
const FIXED_NOW = 1_700_000_000_000; // fake "now" for every run
const TIME_SCALE = 1_000; // divides sleeps: 120 000 ms pause → 120 ms real

const SESSION_ID = "sess-us1";
const RUN_TIMEOUT_MS = 30_000; // belt-and-suspenders so the suite can never hang
const INSTANT_THRESHOLD_MS = 2_000;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slow-down-pacing-hook-"));
}

function writeSessionState(dir, sessionId, parcel) {
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, ...parcel }, null, 2),
  );
}

function readSessionState(dir, sessionId) {
  const raw = fs.readFileSync(path.join(dir, "sessions", `${sessionId}.json`), "utf8");
  return JSON.parse(raw);
}

function runHook(dir, stdin) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    SLOW_DOWN_DATA_DIR: dir,
    SLOW_DOWN_NOW: String(FIXED_NOW),
    SLOW_DOWN_TIME_SCALE: String(TIME_SCALE),
  };
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: "utf8",
    env,
    timeout: RUN_TIMEOUT_MS,
  });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

function stopInput() {
  return JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Stop", stop_hook_active: false });
}

function assertSilentSuccess(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit code 0 (got ${r.status})`);
  assert.equal(r.stdout, "", `${label}: stdout must be empty (FR-004)`);
  assert.equal(r.stderr, "", `${label}: stderr must be empty (FR-004)`);
  assert.equal(r.error, undefined, `${label}: no spawn error (${r.error})`);
}

test("work phase: exits 0 silently and near-instant, no state write needed", () => {
  const dir = makeTmpDir();
  try {
    // Mid-work: elapsed = work/2 → recommended-action KeepWorking.
    writeSessionState(dir, SESSION_ID, { enabled: true, phase: "work", cycleStartedAt: FIXED_NOW - WORK_MS / 2 });
    const r = runHook(dir, stopInput());
    assertSilentSuccess(r, "work phase");
    assert.ok(r.elapsedMs < INSTANT_THRESHOLD_MS, `work phase should be near-instant, took ${r.elapsedMs} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pause phase: exits 0 silently, wall-clock elapsed ≈ scaled pause duration (±2 s)", () => {
  const dir = makeTmpDir();
  try {
    // Mid-pause: elapsed = work + pause/2 → remaining pause = pause/2.
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "pause",
      cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2,
    });
    const scaledMs = PAUSE_MS / 2 / TIME_SCALE; // 120 ms real
    const r = runHook(dir, stopInput());
    assertSilentSuccess(r, "pause phase");
    assert.ok(r.elapsedMs >= scaledMs, `pause run must actually wait ≥ ${scaledMs} ms (took ${r.elapsedMs} ms)`);
    assert.ok(
      r.elapsedMs <= scaledMs + 2_000,
      `pause run exceeded the ±2 s tolerance (took ${r.elapsedMs} ms)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("after a pause, state advances to the next cycle's work phase exactly one cycle (FR-011)", () => {
  const dir = makeTmpDir();
  try {
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "pause",
      cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2,
    });
    runHook(dir, stopInput());

    const state = readSessionState(dir, SESSION_ID);
    assert.equal(state.enabled, true);
    assert.equal(state.phase, "work");
    // cycleStartedAt_old = NOW − work − pause/2; after one full cycle advance:
    // NOW − work − pause/2 + work + pause = NOW + pause/2.
    assert.equal(state.cycleStartedAt, FIXED_NOW + PAUSE_MS / 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cycle complete at entry: idle time is consumed, cycleStartedAt advances, exits 0 silently (FR-011)", () => {
  const dir = makeTmpDir();
  try {
    // 2 full cycles + half a work phase elapsed since cycleStartedAt → the
    // continuous timer consumed them all; the stored boundary must advance.
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "work",
      cycleStartedAt: FIXED_NOW - 2 * CYCLE_MS - WORK_MS / 2,
    });
    const r = runHook(dir, stopInput());
    assertSilentSuccess(r, "cycle complete at entry");
    assert.ok(r.elapsedMs < INSTANT_THRESHOLD_MS, `expected near-instant, took ${r.elapsedMs} ms`);

    const state = readSessionState(dir, SESSION_ID);
    assert.equal(state.phase, "work");
    assert.equal(state.cycleStartedAt, FIXED_NOW - WORK_MS / 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hook_event_name ≠ Stop: silent no-op even with enabled+paused state (data-model §4)", () => {
  const dir = makeTmpDir();
  try {
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "pause",
      cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2,
    });
    const input = JSON.stringify({ session_id: SESSION_ID, hook_event_name: "UserPromptSubmit", stop_hook_active: false });
    const r = runHook(dir, input);
    assertSilentSuccess(r, "non-Stop event");
    assert.ok(r.elapsedMs < INSTANT_THRESHOLD_MS, `non-Stop should be near-instant, took ${r.elapsedMs} ms`);
    // State untouched — it would still be in pause, but a non-Stop event must
    // not sleep or write anything.
    assert.equal(readSessionState(dir, SESSION_ID).phase, "pause");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop_hook_active: true: silent no-op even mid-pause (data-model §4)", () => {
  const dir = makeTmpDir();
  try {
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "pause",
      cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2,
    });
    const input = JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Stop", stop_hook_active: true });
    const r = runHook(dir, input);
    assertSilentSuccess(r, "stop_hook_active=true");
    assert.ok(r.elapsedMs < INSTANT_THRESHOLD_MS, `stop_hook_active should be near-instant, took ${r.elapsedMs} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repetition: after a completed pause, the same inputs hit the fresh work phase (US1 repetition, FR-010a)", () => {
  const dir = makeTmpDir();
  try {
    writeSessionState(dir, SESSION_ID, {
      enabled: true,
      phase: "pause",
      cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2,
    });

    // Pass 1: mid-pause → sleeps the scaled duration.
    const pass1 = runHook(dir, stopInput());
    assertSilentSuccess(pass1, "pass 1");
    assert.ok(pass1.elapsedMs >= PAUSE_MS / 2 / TIME_SCALE, `pass 1 must wait, took ${pass1.elapsedMs} ms`);

    // Pass 2: same inputs, state advanced by pass 1 → work-phase no-op: the
    // stored cycle boundary (NOW + pause/2) is ahead of the fake clock in this
    // synthetic scenario; recomputation must not surface a stale pause.
    const pass2 = runHook(dir, stopInput());
    assertSilentSuccess(pass2, "pass 2");
    assert.ok(pass2.elapsedMs < INSTANT_THRESHOLD_MS, `pass 2 must be an instant work no-op, took ${pass2.elapsedMs} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hostile path-shaped session_id is a silent no-op and cannot reach state files (review F3)", () => {
  const dir = makeTmpDir();
  try {
    // Plant an enabled mid-pause state OUTSIDE sessions/ — exactly where a
    // traversal id like "../evil" would resolve. The shape guard must stop the
    // id before it ever reaches state.mjs's path.join.
    fs.writeFileSync(
      path.join(dir, "evil.json"),
      JSON.stringify({ sessionId: "../evil", enabled: true, phase: "pause", cycleStartedAt: FIXED_NOW - WORK_MS - PAUSE_MS / 2 }),
    );
    const before = fs.readFileSync(path.join(dir, "evil.json"), "utf8");

    const input = JSON.stringify({ session_id: "../evil", hook_event_name: "Stop", stop_hook_active: false });
    const r = runHook(dir, input);
    assertSilentSuccess(r, "hostile session_id");
    assert.ok(r.elapsedMs < INSTANT_THRESHOLD_MS, `hostile id must be near-instant, took ${r.elapsedMs} ms`);

    // Untouched: no sleep ran (would have taken the scaled pause) and no write.
    assert.equal(fs.readFileSync(path.join(dir, "evil.json"), "utf8"), before, "traversal target must be untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("killed mid-pause writes nothing; the next run recomputes from the wall clock (FR-008/FR-010a)", async () => {
  const dir = makeTmpDir();
  try {
    const anchor = FIXED_NOW - WORK_MS - 120_000; // 2 min into the pause
    writeSessionState(dir, SESSION_ID, { enabled: true, phase: "pause", cycleStartedAt: anchor });
    const statePath = path.join(dir, "sessions", `${SESSION_ID}.json`);
    const before = fs.readFileSync(statePath, "utf8");

    // Remaining pause = 120 000 ms; scale 60 → 2 s real. SIGTERM lands at
    // ~700 ms, mid-sleep: the sliced-timer loop must let the signal through.
    const env = {
      ...process.env,
      NODE_ENV: "test",
      SLOW_DOWN_DATA_DIR: dir,
      SLOW_DOWN_NOW: String(FIXED_NOW),
      SLOW_DOWN_TIME_SCALE: "60",
    };
    const victim = spawn(process.execPath, [HOOK_PATH], { stdio: ["pipe", "pipe", "pipe"], env });
    victim.stdin.write(stopInput());
    victim.stdin.end();
    setTimeout(() => victim.kill("SIGTERM"), 700);
    const exit = await new Promise((resolve) =>
      victim.on("exit", (code, signal) => resolve({ code, signal })),
    );

    // Signal death: code is null and signal names the killer (143 = 128+15).
    assert.equal(exit.signal, "SIGTERM", `expected SIGTERM death, got code=${exit.code} signal=${exit.signal}`);
    assert.ok(exit.code === null || exit.code === 143, `unexpected exit code ${exit.code}`);
    assert.equal(victim.stdout.read(), null, "killed run: no stdout expected");
    assert.equal(victim.stderr.read(), null, "killed run: no stderr expected");
    assert.equal(fs.readFileSync(statePath, "utf8"), before, "killed pause must not advance state");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
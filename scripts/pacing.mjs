/**
 * Slow-Down Pacing Mode — Stop-hook entry point (scripts/pacing.mjs).
 *
 * User Story 1: Deterministic Work/Pause Cycle.
 *
 * This module is invoked by Claude Code through the Stop hook (hooks.json)
 * every time the model finishes a turn. It synchronously computes where the
 * session sits inside the 5-minute-work / 4-minute-pause cycle and, when the
 * session is mid-pause, sleeps the remaining pause before allowing the next
 * turn to proceed.
 *
 * References:
 * - Spec: FR-001 (cycle), FR-002/FR-002a (5/4 schedule, overrun tolerance),
 *   FR-004 (Model Silence — zero stdout/stderr), FR-008 (graceful degradation),
 *   FR-010a (user prompt breaks the pause), FR-011 (continuous cycle timer,
 *   idle time consumed).
 * - Data Model §3 (phase transition table) and §4 (hook semantics).
 * - Plugin Surface Contract §3 (stdin JSON envelope, NODE_ENV test seams:
 *   SLOW_DOWN_NOW, SLOW_DOWN_TIME_SCALE; black-box test surface).
 * - Constitution: I (Session Integrity — never signal/kill the harness; only
 *   gate its continuation), II (Model Silence), III (Deterministic Pacing).
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

import { readState, writeState } from "./state.mjs";

/** Default schedule per FR-002: 5 minutes work, 4 minutes pause. */
export const DEFAULT_CONFIG = Object.freeze({
  workMs: 5 * 60_000,
  pauseMs: 4 * 60_000,
});

const testMode = (env) => env && env.NODE_ENV === "test";

/**
 * Computes the phase of the work/pause cycle for the current wall-clock `now`.
 *
 * Pure function of (state, config, now) — no I/O, no randomness, no hidden
 * state (Constitution III). `now` is injectable, which makes the default
 * 5/4-minute schedule fully exercisable in tests at millisecond resolution.
 *
 * The cycle is a continuous free-running timer anchored at
 * `state.cycleStartedAt`: elapsed = now − cycleStartedAt; the phase is the
 * position of `now` inside the cycle (FR-011). Idle time when no hook ran is
 * consumed by the modulo — a hook late past several cycles lands in whichever
 * phase the continuous clock says it is now (data-model §3, FR-010a).
 *
 * @param {{cycleStartedAt: number}} state  session state (uses cycleStartedAt)
 * @param {{workMs: number, pauseMs: number}} config  cycle durations (ms)
 * @param {number} now  current wall-clock time in ms since epoch (injectable)
 * @returns {{phase: "work"|"pause", remainingMs: number, nextCycleStartedAt: number}}
 *          nextCycleStartedAt anchors the wall-clock cycle containing `now`.
 */
export function computePhase(state, config, now) {
  const { workMs, pauseMs } = config;
  const cycleMs = workMs + pauseMs;

  // Clamp negative elapsed (future-dated anchor / clock regression) so the
  // modulo offset always stays in [0, cycleMs): remainingMs never exceeds the
  // phase length and the stored boundary is never rebased backwards.
  const elapsed = Math.max(0, now - state.cycleStartedAt);
  // Offset inside the current cycle. The modulo over the continuous elapsed
  // time is what makes the timer deterministic across runs (FR-011).
  const offset = elapsed % cycleMs;
  // Wall-clock start of the cycle that contains `now`.
  const currentCycleStart = state.cycleStartedAt + elapsed - offset;

  if (offset < workMs) {
    return { phase: "work", remainingMs: workMs - offset, nextCycleStartedAt: currentCycleStart };
  }
  return { phase: "pause", remainingMs: cycleMs - offset, nextCycleStartedAt: currentCycleStart };
}

/**
 * Resolves the effective "now" for the cycle computation.
 * Test seam: SLOW_DOWN_NOW (contract §3, NODE_ENV=test only).
 */
function resolveNow(env = process.env) {
  if (testMode(env) && env.SLOW_DOWN_NOW) {
    const now = Number(env.SLOW_DOWN_NOW);
    if (Number.isFinite(now) && now > 0) {
      return now;
    }
  }
  return Date.now();
}

/**
 * Resolves the pause duration divisor.
 * Test seam: SLOW_DOWN_TIME_SCALE (contract §3, NODE_ENV=test only) — divides
 * the real sleep so black-box tests of a 4-minute pause run in milliseconds.
 */
function resolveScale(env = process.env) {
  if (testMode(env) && env.SLOW_DOWN_TIME_SCALE) {
    const scale = Number(env.SLOW_DOWN_TIME_SCALE);
    if (Number.isFinite(scale) && scale > 0) {
      return scale;
    }
  }
  return 1;
}

/**
 * Waits `realMs` milliseconds of wall clock.
 *
 * Sliced-timer design (review F1 — replaced the original setImmediate busy
 * loop, which measured 101% of a core for the whole pause):
 * - The deadline is a fixed wall-clock instant, re-checked after every slice,
 *   so timer coalescing or early fires can never extend the pause beyond
 *   tolerance (FR-011).
 * - Each slice is an ordinary pending setTimeout: Node delivers signals
 *   between event-loop turns, so a hook timeout (FR-008 degradation) or a user
 *   abort (FR-010a) terminates the process mid-pause just as instantly as with
 *   a spinning loop — verified by the integration kill test.
 * - CPU cost is ~0 for the whole pause (one wakeup per slice) — a pacing
 *   plugin must not burn a core while waiting.
 * - If the process is killed mid-wait, nothing is written afterwards — the
 *   next hook run recomputes the phase purely from cycleStartedAt + wall clock
 *   (FR-010a), so an interrupted pause never blocks the next turn.
 */
async function sleep(realMs) {
  const deadline = Date.now() + realMs;
  while (Date.now() < deadline) {
    const slice = Math.min(deadline - Date.now(), 1000);
    await new Promise((resolve) => setTimeout(resolve, slice));
  }
}

/**
 * Runs the pacing state machine for a single hook invocation.
 *
 * Entry contract (plugin-surface §3): every path exits silently with code 0
 * and zero stdout/stderr (FR-004). Short-circuit guards run first — any hook
 * maintenance/debug path is a no-op that must never sleep or touch state
 * (data-model §4):
 *   1. stdin not valid JSON                → no-op (exit 0)
 *   2. missing session_id                  → no-op (cannot scope state)
 *   3. hook_event_name !== "Stop"          → no-op (only Stop gates turns)
 *   4. stop_hook_active === true           → no-op (a stop is already in
 *                                              progress; never stack a pause)
 *   5. state missing / enabled !== true    → no-op (pacing off, FR-007)
 *   6. invalid cycleStartedAt              → no-op (corrupt state → fail closed)
 *
 * Then, on a valid enabled session mid-cycle:
 *   - work   → exit 0. If a cycle boundary passed while no hook ran, the
 *              stored boundary is advanced so the continuous timer stays
 *              anchored to real cycle starts (FR-011) — still silent.
 *   - pause  → sleep remaining/scale, advance cycleStartedAt by exactly one
 *              full cycle (next cycle is work), persist, exit 0.
 *
 * @param {string} input   raw stdin bytes (JSON envelope from the hook)
 * @param {NodeJS.ProcessEnv} env   environment (defaults to process.env)
 * @returns {Promise<number>} exit status (always 0 — silence is the contract)
 */
export async function runHook(input, env = process.env) {
  let envelope = null;
  try {
    envelope = JSON.parse(input);
  } catch {
    return 0; // guard 1: malformed envelope is never our signal
  }
  if (!envelope || typeof envelope !== "object") {
    return 0;
  }

  const sessionId = envelope.session_id;
  // Guard 2, incl. shape check (review F3): a path-shaped session_id must
  // never reach state.mjs's path.join (traversal hardening).
  if (typeof sessionId !== "string" || sessionId.length === 0 || !/^[\w.-]+$/.test(sessionId)) {
    return 0;
  }
  if (envelope.hook_event_name !== "Stop") {
    return 0; // guard 3
  }
  if (envelope.stop_hook_active === true) {
    return 0; // guard 4
  }

  const state = readState(sessionId, env);
  if (!state || state.enabled !== true) {
    return 0; // guard 5
  }
  if (typeof state.cycleStartedAt !== "number" || !Number.isFinite(state.cycleStartedAt)) {
    return 0; // guard 6
  }

  // Phase 3 scope: the built-in default schedule. Wiring user configuration
  // (config.mjs) into this call is a later task (T015/T017, FR-005).
  const config = DEFAULT_CONFIG;
  const now = resolveNow(env);
  const { phase, remainingMs, nextCycleStartedAt } = computePhase(state, config, now);

  if (phase === "work") {
    if (nextCycleStartedAt !== state.cycleStartedAt) {
      // A full cycle (or more) elapsed while no hook ran: rebase the stored
      // boundary onto the current wall-clock cycle so the next computation
      // stays anchored (FR-011). Silent, near-instant. The full existing
      // parcel is re-persisted (spread) so enablement and other session
      // fields survive the write.
      writeState(sessionId, { ...state, cycleStartedAt: nextCycleStartedAt, phase: "work" }, env);
    }
    return 0;
  }

  // Pause phase: hold the next turn for the remaining pause (FR-001). The
  // sleep is what the Stop hook's 86400 s timeout is dimensioned for
  // (research R1); a killed wait degrades gracefully (FR-008/FR-010a).
  await sleep(Math.max(0, Math.round(remainingMs / resolveScale(env))));

  // Re-read after the (possibly minutes-long) pause: only advance the
  // boundary if the session is still enabled and the anchor has not moved,
  // so a concurrent state change (e.g. pacing disabled mid-pause) is never
  // clobbered by this stale pre-sleep snapshot (review S1).
  const fresh = readState(sessionId, env);
  if (fresh && fresh.enabled === true && fresh.cycleStartedAt === state.cycleStartedAt) {
    // The pause is over: advance the continuous timer by one full cycle. The
    // next cycle begins in the work phase at this instant (FR-011). If this
    // write is interrupted (process killed), nothing is persisted and the next
    // run recomputes from the old boundary — still correct. The fresh parcel
    // is re-persisted (spread) so concurrent session fields survive the write.
    writeState(sessionId, { ...fresh, cycleStartedAt: nextCycleStartedAt + config.workMs + config.pauseMs, phase: "work" }, env);
  }
  return 0;
}

/**
 * Reads stdin (available only when invoked as a script) and runs the hook.
 * Any failure is swallowed: the hook contract is exit 0, always.
 */
async function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    return; // stdin unavailable → nothing to act on (still silent exit 0)
  }
  await runHook(input);
}

// Run only when executed directly (node scripts/pacing.mjs), never when
// imported by the test suites (which exercise computePhase/runHook).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
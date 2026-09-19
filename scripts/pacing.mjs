/**
 * Slow-Down Pacing Mode — Stop-hook entry point (scripts/pacing.mjs).
 *
 * User Story 1: Deterministic Work/Pause Cycle.
 * User Story 3 / T017: Configuration Resolution & Pending Adoption Wiring.
 *
 * This module is invoked by Claude Code through the Stop hook (hooks.json)
 * every time the model finishes a turn. It synchronously computes where the
 * session sits inside the 5-minute-work / 4-minute-pause cycle and, when the
 * session is mid-pause, sleeps the remaining pause before allowing the next
 * turn to proceed.
 *
 * References:
 * - Spec: FR-001 (cycle), FR-002/FR-002a (5/4 schedule, overrun tolerance),
 *   FR-004 (Model Silence — zero stdout/stderr), FR-005 (config), FR-006 (pending adoption),
 *   FR-008 (graceful degradation), FR-010a (user prompt breaks the pause),
 *   FR-011 (continuous cycle timer, idle time consumed).
 * - Data Model §3 (phase transition table) and §4 (hook semantics).
 * - Plugin Surface Contract §3 (stdin JSON envelope, NODE_ENV test seams:
 *   SLOW_DOWN_NOW, SLOW_DOWN_TIME_SCALE; black-box test surface).
 * - Constitution: I (Session Integrity — never signal/kill the harness; only
 *   gate its continuation), II (Model Silence), III (Deterministic Pacing).
 *
 * US2 hardening (T012): the output contract is structurally guaranteed, not
 * incidental. runHook wraps its whole body in a top-level try/catch — ANY
 * internal error, including one thrown two layers deep in a helper, degrades
 * to a silent exit 0. stderr is never written anywhere in this module; stdout
 * is written in exactly ONE place — runHook, only after the whole body has
 * succeeded — and only for the single permitted `{"systemMessage": ...}`
 * misconfiguration notice (FR-007, US3), which executeHook RETURNS rather
 * than writes (qodo PR #6 review).
 *
 * US4 (T022): `projectStatus` is a read-only projection for
 * `/slow-down-pacing:status`. The only human-visible pause surfaces are the
 * static `hooks/hooks.json` `statusMessage` spinner and that slash command —
 * neither reaches the model (FR-009, Constitution II).
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveConfig } from "./config.mjs";
import { applyPending, readState, resolveStateDir, writeState } from "./state.mjs";

export { DEFAULT_CONFIG } from "./config.mjs";

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
 * Human-visible status projection for `/slow-down-pacing:status` (FR-009, US4).
 *
 * Read-only: calls `readState` only — never writes state, never adopts pending,
 * never touches settings. Phase + remaining reuse `computePhase` (T008).
 *
 * @param {string} sessionId
 * @param {{workMs: number, pauseMs: number, sourcePerKey?: object}} config
 * @param {number} now
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean,
 *   phase: "work"|"pause"|null,
 *   remainingInPhaseMs: number|null,
 *   workMs: number,
 *   pauseMs: number,
 *   sourcePerKey: object,
 *   marker: "pacing is off (default)"|null,
 * }}
 */
export function projectStatus(sessionId, config, now, env = process.env) {
  const sourcePerKey = config.sourcePerKey ?? {
    workMinutes: "default",
    pauseMinutes: "default",
  };
  const base = {
    workMs: config.workMs,
    pauseMs: config.pauseMs,
    sourcePerKey,
  };

  // R-CONF-2 (review F1, phase 6): a poisoned configuration means pacing is
  // NOT running regardless of the state file — report the suspension with
  // its reason instead of a live countdown for a cycle that will never
  // execute. Checked before the state read: a never-enabled session with
  // invalid settings never reaches the hook's FR-007 notice (its state
  // guard short-circuits first), so this projection is the only surfacing.
  if (config.disabled === true) {
    return {
      enabled: false,
      phase: null,
      remainingInPhaseMs: null,
      marker: null,
      noticeReason:
        typeof config.noticeReason === "string" && config.noticeReason.length > 0
          ? config.noticeReason
          : "Configuration invalid",
      ...base,
    };
  }

  const state = readState(sessionId, env);
  if (!state) {
    return {
      enabled: false,
      phase: null,
      remainingInPhaseMs: null,
      marker: "pacing is off (default)",
      ...base,
    };
  }

  if (state.enabled !== true) {
    return {
      enabled: false,
      phase: null,
      remainingInPhaseMs: null,
      marker: null,
      ...base,
    };
  }

  if (typeof state.cycleStartedAt !== "number" || !Number.isFinite(state.cycleStartedAt)) {
    return {
      enabled: false,
      phase: null,
      remainingInPhaseMs: null,
      marker: null,
      ...base,
    };
  }

  const { phase, remainingMs } = computePhase(state, config, now);
  return {
    enabled: true,
    phase,
    remainingInPhaseMs: remainingMs,
    marker: null,
    ...base,
  };
}

/**
 * Formats a `projectStatus` result for human-facing stdout (slash command).
 * Never used by the Stop hook — keeps model-silence intact (FR-009 / US2).
 */
export function formatStatusReport(status) {
  // Configuration suspension beats every other inactive marker (review F1).
  // The projection already guarantees a non-empty reason, so it stands alone
  // (qodo PR #8: no doubled "configuration invalid" prefix).
  if (typeof status.noticeReason === "string" && status.noticeReason.length > 0) {
    return `Slow-down pacing: NOT running — ${status.noticeReason}`;
  }
  if (status.marker === "pacing is off (default)") {
    return "Slow-down pacing: pacing is off (default).";
  }
  if (!status.enabled) {
    return "Slow-down pacing: disabled.";
  }

  const workMin = status.workMs / 60_000;
  const pauseMin = status.pauseMs / 60_000;
  const remainingSec = Math.max(0, Math.ceil(status.remainingInPhaseMs / 1000));
  const src = status.sourcePerKey ?? {};
  const workSrc = src.workMinutes ?? "default";
  const pauseSrc = src.pauseMinutes ?? "default";

  return [
    "Slow-down pacing: enabled.",
    `Phase: ${status.phase} (${remainingSec}s remaining).`,
    `Work: ${workMin} min (${workSrc}), pause: ${pauseMin} min (${pauseSrc}).`,
  ].join("\n");
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
  try {
    const systemMessage = await executeHook(input, env);
    // The single permitted stdout emission (FR-007, US3/T017): executeHook
    // never writes output itself — it RETURNS the optional notice, and the one
    // write happens here, only after the whole body has succeeded. An error
    // anywhere downstream of a future notice decision therefore cannot leak
    // partial output while still exiting 0 (qodo PR #6 review).
    if (typeof systemMessage === "string" && systemMessage.length > 0) {
      process.stdout.write(JSON.stringify({ systemMessage }));
    }
    return 0;
  } catch {
    // US2/T012 hardening: the ENTIRE hook body is wrapped here. Any internal
    // error — even one thrown two layers deep in a helper (e.g. a throwing env
    // accessor inside state.mjs) — degrades to a silent no-op. Because the
    // only permitted write happens above — AFTER full success — no error path
    // can emit output. The silence contract is structural, not incidental
    // (FR-004/FR-008).
    return 0;
  }
}

/**
 * Internal hook logic — never called directly; guarded by runHook's top-level
 * try/catch. Guard order is load-bearing: every short-circuit below must exit
 * before reading or writing any state.
 *
 * Output contract: NEVER writes stdout directly. Returns the optional FR-007
 * misconfiguration notice (a non-empty string) for runHook to emit as the
 * single permitted `{"systemMessage": ...}` write after full success; every
 * current path returns undefined (no notice exists until US3/T017).
 */
async function executeHook(input, env) {
  let envelope = null;
  try {
    envelope = JSON.parse(input);
  } catch {
    return undefined; // guard 1: malformed envelope is never our signal
  }
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }

  const sessionId = envelope.session_id;
  // Guard 2, incl. shape check (review F3): a path-shaped session_id must
  // never reach state.mjs's path.join (traversal hardening).
  if (typeof sessionId !== "string" || sessionId.length === 0 || !/^[\w.-]+$/.test(sessionId)) {
    return undefined;
  }
  if (envelope.hook_event_name !== "Stop") {
    return undefined; // guard 3
  }
  if (envelope.stop_hook_active === true) {
    return undefined; // guard 4
  }

  // Pending adoption (FR-006, US3/T017): adopt pending enable/disable before
  // reading session state and evaluating the transition table.
  applyPending(resolveStateDir(env), sessionId, resolveNow(env));

  const state = readState(sessionId, env);
  if (!state || state.enabled !== true) {
    return undefined; // guard 5
  }
  if (typeof state.cycleStartedAt !== "number" || !Number.isFinite(state.cycleStartedAt)) {
    return undefined; // guard 6
  }

  const config = resolveConfig(env);
  if (config.disabled === true) {
    if (state.disabledNoticeShown === true) {
      return undefined;
    }
    writeState(sessionId, { ...state, disabledNoticeShown: true }, env);
    return config.noticeReason;
  }

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
    return undefined;
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
  return undefined;
}

/**
 * Reads stdin (available only when invoked as a script) and runs the hook.
 * Any failure is swallowed — twice over: the stdin read is guarded, and the
 * whole body sits inside a top-level try/catch. The hook contract is exit 0,
 * always, with neither stdout nor stderr written (FR-004).
 */
async function main() {
  try {
    let input = "";
    try {
      input = fs.readFileSync(0, "utf8");
    } catch {
      return 0; // stdin unavailable → nothing to act on (still silent exit 0)
    }
    return await runHook(input);
  } catch {
    // Last-resort: even a synchronous surprise outside runHook stays a silent
    // no-op — runHook already guarantees 0 for anything it touches.
    return 0;
  }
}

// Run only when executed directly (node scripts/pacing.mjs), never when
// imported by the test suites (which exercise computePhase/runHook).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
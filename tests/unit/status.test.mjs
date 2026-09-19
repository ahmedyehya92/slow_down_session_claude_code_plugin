import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { projectStatus, formatStatusReport } from "../../scripts/pacing.mjs";
import { writeState, resolveStateDir } from "../../scripts/state.mjs";

// T020 — User Story 4 status projection (FR-009).
// Read-only: projectStatus must never create, modify, or delete state files.

const WORK_MS = 5 * 60_000;
const PAUSE_MS = 4 * 60_000;
const T0 = 1_700_000_000_000;

const CONFIG = {
  workMs: WORK_MS,
  pauseMs: PAUSE_MS,
  sourcePerKey: { workMinutes: "default", pauseMinutes: "project" },
  disabled: false,
  noticeReason: null,
};

describe("projectStatus", () => {
  let tmpDir;
  let env;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-down-status-test-"));
    env = {
      NODE_ENV: "test",
      SLOW_DOWN_DATA_DIR: tmpDir,
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  /** Snapshot every file under the data dir (relative path → contents). */
  function snapshotDir() {
    const out = new Map();
    function walk(dir, prefix = "") {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, rel);
        else out.set(rel, fs.readFileSync(full, "utf8"));
      }
    }
    walk(tmpDir);
    return out;
  }

  function assertReadOnly(fn) {
    const before = snapshotDir();
    const result = fn();
    const after = snapshotDir();
    assert.deepEqual(
      [...after.entries()].sort(),
      [...before.entries()].sort(),
      "projectStatus must be read-only (no state writes)",
    );
    return result;
  }

  it("never-enabled (no state file) → enabled false with 'pacing is off (default)' marker", () => {
    const status = assertReadOnly(() => projectStatus("fresh-session", CONFIG, T0, env));

    assert.equal(status.enabled, false);
    assert.equal(status.marker, "pacing is off (default)");
    assert.equal(status.phase, null);
    assert.equal(status.remainingInPhaseMs, null);
    assert.equal(status.workMs, WORK_MS);
    assert.equal(status.pauseMs, PAUSE_MS);
    assert.deepEqual(status.sourcePerKey, CONFIG.sourcePerKey);
    assert.match(formatStatusReport(status), /pacing is off \(default\)/);
  });

  it("disabled-state-file → enabled false, no default marker", () => {
    writeState("sess-off", { enabled: false }, env);
    const status = assertReadOnly(() => projectStatus("sess-off", CONFIG, T0, env));

    assert.equal(status.enabled, false);
    assert.equal(status.marker, null);
    assert.equal(status.phase, null);
    assert.equal(status.remainingInPhaseMs, null);
    assert.equal(status.workMs, WORK_MS);
    assert.equal(status.pauseMs, PAUSE_MS);
    assert.deepEqual(status.sourcePerKey, CONFIG.sourcePerKey);
  });

  it("enabled-at-cycle-start → work phase with full work remaining", () => {
    writeState(
      "sess-start",
      { enabled: true, phase: "work", cycleStartedAt: T0 },
      env,
    );

    const status = assertReadOnly(() => projectStatus("sess-start", CONFIG, T0, env));

    assert.equal(status.enabled, true);
    assert.equal(status.marker, null);
    assert.equal(status.phase, "work");
    assert.equal(status.remainingInPhaseMs, WORK_MS);
    assert.equal(status.workMs, WORK_MS);
    assert.equal(status.pauseMs, PAUSE_MS);
    assert.deepEqual(status.sourcePerKey, CONFIG.sourcePerKey);
  });

  it("enabled-mid-cycle (mid-work) → work phase with correct remaining", () => {
    writeState(
      "sess-mid-work",
      { enabled: true, phase: "work", cycleStartedAt: T0 },
      env,
    );
    const now = T0 + WORK_MS / 2;

    const status = assertReadOnly(() => projectStatus("sess-mid-work", CONFIG, now, env));

    assert.equal(status.enabled, true);
    assert.equal(status.phase, "work");
    assert.equal(status.remainingInPhaseMs, WORK_MS / 2);
  });

  it("enabled-mid-cycle (mid-pause) → pause phase with correct remaining", () => {
    writeState(
      "sess-mid-pause",
      { enabled: true, phase: "work", cycleStartedAt: T0 },
      env,
    );
    const now = T0 + WORK_MS + PAUSE_MS / 2;

    const status = assertReadOnly(() => projectStatus("sess-mid-pause", CONFIG, now, env));

    assert.equal(status.enabled, true);
    assert.equal(status.phase, "pause");
    assert.equal(status.remainingInPhaseMs, PAUSE_MS / 2);
  });

  it("formatStatusReport for enabled includes phase, remaining, durations, and source labels", () => {
    writeState(
      "sess-fmt",
      { enabled: true, phase: "work", cycleStartedAt: T0 },
      env,
    );
    const status = projectStatus("sess-fmt", CONFIG, T0 + 60_000, env);
    const text = formatStatusReport(status);

    assert.match(text, /enabled/i);
    assert.match(text, /work/i);
    assert.match(text, /pause/i);
    assert.match(text, /default/);
    assert.match(text, /project/);
  });

  it("does not create a sessions directory when none exists", () => {
    const status = projectStatus("ghost", CONFIG, T0, env);
    assert.equal(status.enabled, false);
    assert.equal(status.marker, "pacing is off (default)");
    assert.equal(fs.existsSync(resolveStateDir(env)), false);
  });

  it("poisoned config (disabled) → enabled false with noticeReason, never a live countdown (review F1)", () => {
    writeState(
      "sess-poison",
      { enabled: true, phase: "work", cycleStartedAt: T0 - 60_000 },
      env,
    );
    const poisoned = {
      ...CONFIG,
      disabled: true,
      noticeReason: "Invalid workMinutes value at project layer: 0",
    };

    const status = assertReadOnly(() => projectStatus("sess-poison", poisoned, T0, env));

    assert.equal(status.enabled, false);
    assert.equal(status.phase, null);
    assert.equal(status.remainingInPhaseMs, null);
    assert.equal(status.marker, null);
    assert.equal(status.noticeReason, "Invalid workMinutes value at project layer: 0");

    const report = formatStatusReport(status);
    assert.match(report, /NOT running/);
    assert.match(report, /Invalid workMinutes value at project layer/);
    assert.doesNotMatch(report, /remaining\)/, "must not show a countdown for a cycle that will never run");
  });

  it("poisoned config precedes state: never-enabled session gets the reason, not 'off (default)' (review F1)", () => {
    const poisoned = {
      ...CONFIG,
      disabled: true,
      noticeReason: "Failed to parse settings JSON file at /global/settings.json",
    };

    const status = assertReadOnly(() => projectStatus("never-enabled-poison", poisoned, T0, env));

    assert.equal(status.enabled, false);
    assert.notEqual(status.marker, "pacing is off (default)");
    assert.equal(status.noticeReason, "Failed to parse settings JSON file at /global/settings.json");
    assert.match(formatStatusReport(status), /NOT running/);
  });

  it("poisoned config with empty noticeReason falls back to a generic reason", () => {
    const poisoned = { ...CONFIG, disabled: true, noticeReason: null };
    const status = projectStatus("sess-poison-empty-reason", poisoned, T0, env);
    assert.equal(status.enabled, false);
    assert.equal(status.noticeReason, "Configuration invalid");
    assert.match(formatStatusReport(status), /NOT running — configuration invalid\. Configuration invalid/);
  });

  it("enabled with corrupt cycleStartedAt → fail-closed enabled false, prints 'disabled.' (review F4)", () => {
    writeState("sess-corrupt-anchor", { enabled: true, cycleStartedAt: "garbage" }, env);
    const status = assertReadOnly(() => projectStatus("sess-corrupt-anchor", CONFIG, T0, env));

    assert.equal(status.enabled, false);
    assert.equal(status.marker, null);
    assert.equal(status.noticeReason, undefined);
    assert.equal(formatStatusReport(status), "Slow-down pacing: disabled.");
  });

  it("disabled-state-file format: marker null → 'Slow-down pacing: disabled.'", () => {
    writeState("sess-off-fmt", { enabled: false }, env);
    const status = projectStatus("sess-off-fmt", CONFIG, T0, env);
    assert.equal(formatStatusReport(status), "Slow-down pacing: disabled.");
  });
});

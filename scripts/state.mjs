/**
 * Session-state primitives module for Slow-Down Pacing Mode.
 *
 * References:
 * - Data Model (§2 Session Pacing State, R-STATE-1, R-STATE-4):
 *   Per-session pacing state files (`<session_id>.json`) and `pending.json`.
 *   R-STATE-1: Mismatched session IDs inside state files are treated as absent.
 *   R-STATE-4: Privacy / Model Silence — state files and script activity must never surface to stdout/stderr.
 * - Plugin Surface Contract (§3 Test Seams):
 *   `SLOW_DOWN_DATA_DIR` redirects state data directory when `NODE_ENV === "test"`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves the state data directory.
 * Test seam: returns `env.SLOW_DOWN_DATA_DIR` when `env.NODE_ENV === "test"` and set.
 * Otherwise returns `env.CLAUDE_PLUGIN_DATA` or `null` if unset.
 */
export function resolveDataDir(env = process.env) {
  if (env && env.NODE_ENV === "test" && env.SLOW_DOWN_DATA_DIR) {
    return env.SLOW_DOWN_DATA_DIR;
  }
  return (env && env.CLAUDE_PLUGIN_DATA) ? env.CLAUDE_PLUGIN_DATA : null;
}

/**
 * Resolves the sessions state directory (`<dataDir>/sessions`).
 * Returns `null` if the data directory is unresolvable.
 */
export function resolveStateDir(env = process.env) {
  const dataDir = resolveDataDir(env);
  if (!dataDir) {
    return null;
  }
  return path.join(dataDir, "sessions");
}

/**
 * Reads and parses the state file for a given `sessionId`.
 * Returns `null` if unresolvable, missing, unparseable, or if `sessionId` in file mismatches (R-STATE-1).
 */
export function readState(sessionId, env = process.env) {
  if (!sessionId) {
    return null;
  }
  const stateDir = resolveStateDir(env);
  if (!stateDir) {
    return null;
  }

  const filePath = path.join(stateDir, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    // R-STATE-1: mismatch between file content's sessionId and requested sessionId
    if (parsed.sessionId !== sessionId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Writes state for `sessionId` atomically (temp file + rename).
 * Merges state as `{ sessionId, ...parcel }`.
 * Returns `true` on success, `false` if unresolvable or sessionId falsy.
 */
export function writeState(sessionId, parcel, env = process.env) {
  if (!sessionId) {
    return false;
  }
  const stateDir = resolveStateDir(env);
  if (!stateDir) {
    return false;
  }

  const targetPath = path.join(stateDir, `${sessionId}.json`);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.mkdirSync(stateDir, { recursive: true });

    // sessionId last: a parcel carrying its own (possibly stale) sessionId must
    // never override the authoritative filename key (R-STATE-1).
    const data = JSON.stringify({ ...parcel, sessionId }, null, 2);
    fs.writeFileSync(tempPath, data, "utf8");
    fs.renameSync(tempPath, targetPath);
    return true;
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* temp file may not exist */ }
    return false;
  }
}

/**
 * Reads and parses `pending.json`.
 * Returns `null` if unresolvable, missing, or unparseable.
 */
export function readPending(env = process.env) {
  const stateDir = resolveStateDir(env);
  if (!stateDir) {
    return null;
  }

  const filePath = path.join(stateDir, "pending.json");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    // Fail-closed read path, symmetric with writePending's allow-list:
    // corrupted or foreign pending.json must never flow to callers.
    if (parsed.action !== "enable" && parsed.action !== "disable") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Writes pending action atomically to `pending.json`.
 * Action must be "enable" or "disable".
 * Returns `true` on success, `false` if unresolvable or invalid action.
 */
export function writePending({ action, requestedAt }, env = process.env) {
  if (action !== "enable" && action !== "disable") {
    return false;
  }
  const stateDir = resolveStateDir(env);
  if (!stateDir) {
    return false;
  }

  const targetPath = path.join(stateDir, "pending.json");
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.mkdirSync(stateDir, { recursive: true });

    const data = JSON.stringify({ action, requestedAt }, null, 2);
    fs.writeFileSync(tempPath, data, "utf8");
    fs.renameSync(tempPath, targetPath);
    return true;
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* temp file may not exist */ }
    return false;
  }
}

/**
 * Removes `pending.json`.
 * Returns `true` if removed or didn't exist, `false` only if state dir unresolvable.
 * Never throws.
 */
export function deletePending(env = process.env) {
  const stateDir = resolveStateDir(env);
  if (!stateDir) {
    return false;
  }

  const filePath = path.join(stateDir, "pending.json");
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

/**
 * Reads/parses `<stateDir>/<sessionId>.json` without env resolution.
 * Returns null on any failure (missing, unparseable, non-object).
 */
function readStateFileIn(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, `${sessionId}.json`), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Consumes pending.json if present, non-stale (<= 24h), valid, and matching sessionId.
 * Stale intents and complete-but-invalid intents (unknown action) are PRUNED
 * (file deleted) whenever any session's hook encounters them; a fresh valid
 * intent scoped to a different session is preserved for that session (qodo PR #7).
 * Atomically updates state file for sessionId and unlinks pending.json.
 * Returns the state parcel applied ({ enabled: true, phase: "work", cycleStartedAt } or { enabled: false }),
 * or null if no valid/fresh pending action applied or stateDir null.
 * An `enable` for a session already enabled with a valid anchor is a NO-OP
 * adoption (contract §4 /on idempotence, review F3): the pending file is
 * consumed and the existing state parcel returned unchanged — a fresh cycle
 * starts only on an actual transition (never-enabled, disabled, unreadable,
 * or sessionId-mismatched state).
 * Never throws.
 */
export function applyPending(stateDir, sessionId, now = Date.now()) {
  if (!stateDir || !sessionId) {
    return null;
  }

  const pendingPath = path.join(stateDir, "pending.json");
  let pendingRaw;
  try {
    pendingRaw = fs.readFileSync(pendingPath, "utf8");
  } catch {
    return null;
  }

  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return null;
  }

  if (!pending || typeof pending !== "object") {
    return null;
  }

  // Stale check FIRST: requestedAt missing, non-finite, or older than 24 hours
  // (86,400,000 ms) — pruned regardless of session scope, so a stale intent
  // never lingers just because the wrong session's hook saw it (qodo PR #7).
  const { action, requestedAt } = pending;
  const isStale = typeof requestedAt !== "number" ||
    !Number.isFinite(requestedAt) ||
    (now - requestedAt > 24 * 60 * 60 * 1000);

  if (isStale) {
    try { fs.unlinkSync(pendingPath); } catch { /* ignore if already unlinked */ }
    return null;
  }

  // Action allow-list check: a complete-but-invalid intent can never become
  // valid — prune it rather than re-reading it on every hook run (qodo PR #7).
  if (action !== "enable" && action !== "disable") {
    try { fs.unlinkSync(pendingPath); } catch { /* ignore if already unlinked */ }
    return null;
  }

  // Session ID scope check LAST: a fresh, valid intent for another session
  // must be preserved for that session to adopt.
  if (pending.sessionId && pending.sessionId !== sessionId) {
    return null;
  }

  let parcel;
  if (action === "enable") {
    // Contract §4 idempotence (review F3): re-running /on while already
    // enabled (valid anchor, matching sessionId per R-STATE-1) must not
    // restart the running cycle — consume the intent, keep the state.
    const existing = readStateFileIn(stateDir, sessionId);
    if (
      existing &&
      existing.sessionId === sessionId &&
      existing.enabled === true &&
      typeof existing.cycleStartedAt === "number" &&
      Number.isFinite(existing.cycleStartedAt)
    ) {
      try { fs.unlinkSync(pendingPath); } catch { /* already unlinked */ }
      return existing;
    }
    parcel = {
      enabled: true,
      phase: "work",
      cycleStartedAt: now,
    };
  } else {
    parcel = {
      enabled: false,
    };
  }

  const targetPath = path.join(stateDir, `${sessionId}.json`);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const data = JSON.stringify({ ...parcel, sessionId }, null, 2);
    fs.writeFileSync(tempPath, data, "utf8");
    fs.renameSync(tempPath, targetPath);
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* temp file cleanup */ }
    return null;
  }

  try { fs.unlinkSync(pendingPath); } catch { /* cleanup pending */ }

  return parcel;
}

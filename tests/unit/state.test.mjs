import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { applyPending } from "../../scripts/state.mjs";

describe("applyPending", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-down-state-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("1. fresh enable parcel application", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: now - 1000 }));

    const res = applyPending(tmpDir, "sess-1", now);

    assert.deepEqual(res, {
      enabled: true,
      phase: "work",
      cycleStartedAt: now,
    });

    const stateFile = path.join(tmpDir, "sess-1.json");
    const stateContent = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(stateContent, {
      sessionId: "sess-1",
      enabled: true,
      phase: "work",
      cycleStartedAt: now,
    });

    assert.equal(fs.existsSync(pendingFile), false);
  });

  it("2. fresh disable parcel application", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "disable", requestedAt: now - 5000 }));

    const res = applyPending(tmpDir, "sess-2", now);

    assert.deepEqual(res, {
      enabled: false,
    });

    const stateFile = path.join(tmpDir, "sess-2.json");
    const stateContent = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(stateContent, {
      sessionId: "sess-2",
      enabled: false,
    });

    assert.equal(fs.existsSync(pendingFile), false);
  });

  it("3. stale pruning including missing requestedAt", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable" }));

    const res = applyPending(tmpDir, "sess-3", now);

    assert.equal(res, null);
    assert.equal(fs.existsSync(pendingFile), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "sess-3.json")), false);
  });

  it("4. stale pruning including invalid requestedAt", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: "invalid-timestamp" }));

    const res = applyPending(tmpDir, "sess-4", now);

    assert.equal(res, null);
    assert.equal(fs.existsSync(pendingFile), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "sess-4.json")), false);
  });

  it("5. exact 24h boundary behavior", () => {
    const now = 100000000;
    const dayMs = 24 * 60 * 60 * 1000;
    const pendingFile = path.join(tmpDir, "pending.json");

    // Exact 24h boundary (now - requestedAt === 24h) -> Fresh (not > 24h)
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: now - dayMs }));
    const resBoundary = applyPending(tmpDir, "sess-boundary", now);
    assert.deepEqual(resBoundary, {
      enabled: true,
      phase: "work",
      cycleStartedAt: now,
    });
    assert.equal(fs.existsSync(pendingFile), false);

    // 24h + 1ms -> Stale (> 24h)
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: now - (dayMs + 1) }));
    const resStale = applyPending(tmpDir, "sess-stale", now);
    assert.equal(resStale, null);
    assert.equal(fs.existsSync(pendingFile), false);
  });

  it("6. idempotence when pending.json is absent", () => {
    const res = applyPending(tmpDir, "sess-empty", Date.now());
    assert.equal(res, null);
  });

  it("7. sessionId mismatch leaves pending.json untouched", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: now, sessionId: "other-session" }));

    const res = applyPending(tmpDir, "my-session", now);

    assert.equal(res, null);
    assert.equal(fs.existsSync(pendingFile), true);
    assert.equal(fs.existsSync(path.join(tmpDir, "my-session.json")), false);
  });

  it("8. unknown action leaves pending.json untouched", () => {
    const now = 1000000;
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "invalid_action", requestedAt: now }));

    const res = applyPending(tmpDir, "sess-8", now);

    assert.equal(res, null);
    assert.equal(fs.existsSync(pendingFile), true);
    assert.equal(fs.existsSync(path.join(tmpDir, "sess-8.json")), false);
  });

  it("9. invalid JSON leaves pending.json untouched", () => {
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, "{ corrupted json... ");

    const res = applyPending(tmpDir, "sess-9", Date.now());

    assert.equal(res, null);
    assert.equal(fs.existsSync(pendingFile), true);
  });

  it("10. non-existent stateDir returns null cleanly", () => {
    const res = applyPending(path.join(tmpDir, "non-existent-subfolder"), "sess-10", Date.now());
    assert.equal(res, null);
  });

  it("11. null/empty stateDir or sessionId parameters", () => {
    assert.equal(applyPending(null, "sess-11"), null);
    assert.equal(applyPending(tmpDir, null), null);
    assert.equal(applyPending("", "sess-11"), null);
    assert.equal(applyPending(tmpDir, ""), null);
  });

  it("12. enable while already enabled (valid anchor) is a no-op: state untouched, pending consumed (contract §4, review F3)", () => {
    const now = 1000000;
    const stateFile = path.join(tmpDir, "sess-12.json");
    const before = { sessionId: "sess-12", enabled: true, phase: "pause", cycleStartedAt: 999888 };
    fs.writeFileSync(stateFile, JSON.stringify(before));
    const pendingFile = path.join(tmpDir, "pending.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ action: "enable", requestedAt: now - 100 }));

    const res = applyPending(tmpDir, "sess-12", now);

    assert.deepEqual(res, before, "no-op adoption returns the existing parcel");
    assert.equal(fs.readFileSync(stateFile, "utf8"), JSON.stringify(before), "state file must be byte-identical");
    assert.equal(fs.existsSync(pendingFile), false, "pending must still be consumed");
  });

  it("13. enable after disable still applies a fresh cycle (R-STATE-3 toggle convergence)", () => {
    const now = 1000000;
    fs.writeFileSync(path.join(tmpDir, "sess-13.json"), JSON.stringify({ sessionId: "sess-13", enabled: false }));
    fs.writeFileSync(path.join(tmpDir, "pending.json"), JSON.stringify({ action: "enable", requestedAt: now }));

    const res = applyPending(tmpDir, "sess-13", now);
    assert.deepEqual(res, { enabled: true, phase: "work", cycleStartedAt: now });
    const st = JSON.parse(fs.readFileSync(path.join(tmpDir, "sess-13.json"), "utf8"));
    assert.deepEqual(st, { sessionId: "sess-13", enabled: true, phase: "work", cycleStartedAt: now });
  });

  it("14. enable over a corrupt state file applies a fresh cycle (unreadable = absent)", () => {
    const now = 1000000;
    fs.writeFileSync(path.join(tmpDir, "sess-14.json"), "garbage{{{");
    fs.writeFileSync(path.join(tmpDir, "pending.json"), JSON.stringify({ action: "enable", requestedAt: now }));

    const res = applyPending(tmpDir, "sess-14", now);
    assert.deepEqual(res, { enabled: true, phase: "work", cycleStartedAt: now });
  });

  it("15. enable over a sessionId-mismatched state file applies a fresh cycle (R-STATE-1)", () => {
    const now = 1000000;
    fs.writeFileSync(
      path.join(tmpDir, "sess-15.json"),
      JSON.stringify({ sessionId: "someone-else", enabled: true, phase: "work", cycleStartedAt: 555 }),
    );
    fs.writeFileSync(path.join(tmpDir, "pending.json"), JSON.stringify({ action: "enable", requestedAt: now }));

    const res = applyPending(tmpDir, "sess-15", now);
    assert.deepEqual(res, { enabled: true, phase: "work", cycleStartedAt: now });
    const st = JSON.parse(fs.readFileSync(path.join(tmpDir, "sess-15.json"), "utf8"));
    assert.equal(st.sessionId, "sess-15");
  });
});

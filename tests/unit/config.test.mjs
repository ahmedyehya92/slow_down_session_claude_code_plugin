import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { DEFAULT_CONFIG, resolveConfig, resolveSettingsPaths } from "../../scripts/config.mjs";

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-down-config-test-"));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

function writeRaw(filePath, rawString) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rawString, "utf8");
}

test("DEFAULT_CONFIG contract: is frozen and has 300000/240000 defaults", () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.deepEqual(DEFAULT_CONFIG, {
    workMs: 300000,
    pauseMs: 240000,
  });
});

test("Case 1: No seams set with NODE_ENV: 'test' → default 300000/240000, disabled: false, noticeReason: null", () => {
  const cfg = resolveConfig({ NODE_ENV: "test" });
  assert.deepEqual(cfg, {
    workMs: 300000,
    pauseMs: 240000,
    sourcePerKey: {
      workMinutes: "default",
      pauseMinutes: "default",
    },
    disabled: false,
    noticeReason: null,
  });
});

test("Case 2: Project overrides both keys → sourcePerKey both 'project', values scaled by 60_000", () => {
  withTempDir((tmpDir) => {
    const projPath = path.join(tmpDir, "project-settings.json");
    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 7,
        pauseMinutes: 3,
      },
    });

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, false);
    assert.equal(cfg.noticeReason, null);
    assert.equal(cfg.workMs, 420000);
    assert.equal(cfg.pauseMs, 180000);
    assert.deepEqual(cfg.sourcePerKey, {
      workMinutes: "project",
      pauseMinutes: "project",
    });
  });
});

test("Case 3: Project seam points to NON-EXISTENT path, global valid → both 'global'", () => {
  withTempDir((tmpDir) => {
    const globalPath = path.join(tmpDir, "global-settings.json");
    writeJson(globalPath, {
      slowDownPacing: {
        workMinutes: 10,
        pauseMinutes: 2,
      },
    });
    const missingProjPath = path.join(tmpDir, "nonexistent-project-settings.json");

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_GLOBAL_SETTINGS: globalPath,
      SLOW_DOWN_PROJECT_SETTINGS: missingProjPath,
    });

    assert.equal(cfg.disabled, false);
    assert.equal(cfg.noticeReason, null);
    assert.equal(cfg.workMs, 600000);
    assert.equal(cfg.pauseMs, 120000);
    assert.deepEqual(cfg.sourcePerKey, {
      workMinutes: "global",
      pauseMinutes: "global",
    });
  });
});

test("Case 4: Per-key mixing: project defines only workMinutes, global defines pauseMinutes → work 'project', pause 'global'", () => {
  withTempDir((tmpDir) => {
    const globalPath = path.join(tmpDir, "global.json");
    const projPath = path.join(tmpDir, "project.json");

    writeJson(globalPath, {
      slowDownPacing: {
        workMinutes: 10,
        pauseMinutes: 8,
      },
    });

    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 6,
      },
    });

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_GLOBAL_SETTINGS: globalPath,
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, false);
    assert.equal(cfg.noticeReason, null);
    assert.equal(cfg.workMs, 360000);
    assert.equal(cfg.pauseMs, 480000);
    assert.deepEqual(cfg.sourcePerKey, {
      workMinutes: "project",
      pauseMinutes: "global",
    });
  });
});

test("Case 5: POISON no-fall-through: project workMinutes invalid (0) but global valid → disabled:true, defaults returned, sourcePerKey.workMinutes === 'project'", () => {
  withTempDir((tmpDir) => {
    const globalPath = path.join(tmpDir, "global.json");
    const projPath = path.join(tmpDir, "project.json");

    writeJson(globalPath, {
      slowDownPacing: {
        workMinutes: 10,
        pauseMinutes: 4,
      },
    });

    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 0,
      },
    });

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_GLOBAL_SETTINGS: globalPath,
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, true);
    assert.equal(typeof cfg.noticeReason, "string");
    assert.ok(cfg.noticeReason.length > 0);
    assert.equal(cfg.workMs, DEFAULT_CONFIG.workMs);
    assert.equal(cfg.pauseMs, DEFAULT_CONFIG.pauseMs);
    assert.equal(cfg.sourcePerKey.workMinutes, "project");
    assert.equal(cfg.sourcePerKey.pauseMinutes, "global");
  });
});

test("Case 6: slowDownPacing is a string (not object) in project → disabled:true even with valid global", () => {
  withTempDir((tmpDir) => {
    const globalPath = path.join(tmpDir, "global.json");
    const projPath = path.join(tmpDir, "project.json");

    writeJson(globalPath, {
      slowDownPacing: {
        workMinutes: 5,
        pauseMinutes: 4,
      },
    });

    writeJson(projPath, {
      slowDownPacing: "invalid_string_config",
    });

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_GLOBAL_SETTINGS: globalPath,
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, true);
    assert.ok(typeof cfg.noticeReason === "string" && cfg.noticeReason.length > 0);
    assert.equal(cfg.workMs, DEFAULT_CONFIG.workMs);
    assert.equal(cfg.pauseMs, DEFAULT_CONFIG.pauseMs);
  });
});

test("Case 7: Project settings file contains INVALID JSON → disabled:true", () => {
  withTempDir((tmpDir) => {
    const projPath = path.join(tmpDir, "project.json");
    writeRaw(projPath, "{ invalid json content ... ");

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, true);
    assert.ok(typeof cfg.noticeReason === "string" && cfg.noticeReason.length > 0);
    assert.equal(cfg.workMs, DEFAULT_CONFIG.workMs);
    assert.equal(cfg.pauseMs, DEFAULT_CONFIG.pauseMs);
  });
});

test("Case 8: Invalid values (-5, NaN, '7', null) → disabled:true", () => {
  const invalidValues = [-5, NaN, Infinity, -Infinity, "7", null, true, false, [], {}];

  for (const val of invalidValues) {
    withTempDir((tmpDir) => {
      const projPath = path.join(tmpDir, "project.json");
      writeJson(projPath, {
        slowDownPacing: {
          workMinutes: val,
        },
      });

      const cfg = resolveConfig({
        NODE_ENV: "test",
        SLOW_DOWN_PROJECT_SETTINGS: projPath,
      });

      assert.equal(cfg.disabled, true, `value ${JSON.stringify(val)} should disable config`);
      assert.ok(typeof cfg.noticeReason === "string" && cfg.noticeReason.length > 0);
      assert.equal(cfg.workMs, DEFAULT_CONFIG.workMs);
      assert.equal(cfg.pauseMs, DEFAULT_CONFIG.pauseMs);
    });
  }
});

test("Case 9: Unknown key present (e.g. statusMessage: 'x') with valid numbers → NOT disabled, values correct", () => {
  withTempDir((tmpDir) => {
    const projPath = path.join(tmpDir, "project.json");
    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 8,
        pauseMinutes: 6,
        statusMessage: "Custom spinner text",
        randomKey: 12345,
      },
    });

    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    });

    assert.equal(cfg.disabled, false);
    assert.equal(cfg.noticeReason, null);
    assert.equal(cfg.workMs, 480000);
    assert.equal(cfg.pauseMs, 360000);
  });
});

test("Case 10: Seams ignored when NODE_ENV !== 'test' → production paths used, seam files ignored", () => {
  withTempDir((tmpDir) => {
    const projPath = path.join(tmpDir, "project.json");
    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 1,
        pauseMinutes: 1,
      },
    });

    // Empty "real" locations keep the production fallback hermetic — the test
    // must never read the developer's actual ~/.claude or repo settings.
    const emptyHome = path.join(tmpDir, "empty-home");
    const emptyCwd = path.join(tmpDir, "empty-cwd");

    const cfgProd = resolveConfig(
      { NODE_ENV: "production", SLOW_DOWN_PROJECT_SETTINGS: projPath },
      { homeDir: emptyHome, cwd: emptyCwd },
    );

    assert.equal(cfgProd.disabled, false);
    assert.equal(cfgProd.noticeReason, null);
    assert.equal(cfgProd.workMs, 300000);
    assert.equal(cfgProd.pauseMs, 240000);
    assert.deepEqual(cfgProd.sourcePerKey, {
      workMinutes: "default",
      pauseMinutes: "default",
    });

    const cfgUnset = resolveConfig({}, { homeDir: emptyHome, cwd: emptyCwd });
    assert.equal(cfgUnset.disabled, false);
    assert.equal(cfgUnset.workMs, 300000);
    assert.equal(cfgUnset.pauseMs, 240000);
  });
});

test("resolveSettingsPaths: test mode — seams override per layer; unset layers are null (no real-path leakage)", () => {
  const both = resolveSettingsPaths({
    NODE_ENV: "test",
    SLOW_DOWN_GLOBAL_SETTINGS: "/g.json",
    SLOW_DOWN_PROJECT_SETTINGS: "/p.json",
  });
  assert.deepEqual(both, { globalPath: "/g.json", projectPath: "/p.json" });

  const partial = resolveSettingsPaths({ NODE_ENV: "test", SLOW_DOWN_GLOBAL_SETTINGS: "/g.json" });
  assert.deepEqual(partial, { globalPath: "/g.json", projectPath: null });

  const none = resolveSettingsPaths({ NODE_ENV: "test" });
  assert.deepEqual(none, { globalPath: null, projectPath: null });
});

test("resolveSettingsPaths: production — real locations from injectable home/cwd; seams do NOT win", () => {
  const p = resolveSettingsPaths(
    { NODE_ENV: "production", SLOW_DOWN_GLOBAL_SETTINGS: "/g.json", SLOW_DOWN_PROJECT_SETTINGS: "/p.json" },
    "/home/tester",
    "/work/project",
  );
  assert.deepEqual(p, {
    globalPath: "/home/tester/.claude/settings.json",
    projectPath: "/work/project/.claude/settings.json",
  });
});

test("Case 11 (review F1 regression): PRODUCTION resolveConfig actually reads the real settings locations", () => {
  withTempDir((tmpDir) => {
    const homeDir = path.join(tmpDir, "home");
    const cwd = path.join(tmpDir, "cwd");
    writeJson(path.join(homeDir, ".claude", "settings.json"), { slowDownPacing: { workMinutes: 9 } });
    writeJson(path.join(cwd, ".claude", "settings.json"), { slowDownPacing: { pauseMinutes: 7 } });

    const cfg = resolveConfig({ NODE_ENV: "production" }, { homeDir, cwd });
    assert.equal(cfg.disabled, false);
    assert.equal(cfg.workMs, 9 * 60_000, "global layer must be read in production");
    assert.equal(cfg.pauseMs, 7 * 60_000, "project layer must be read in production");
    assert.deepEqual(cfg.sourcePerKey, { workMinutes: "global", pauseMinutes: "project" });
  });
});

test("Case 11b (review F1 regression): PRODUCTION poison settings yield disabled:true + notice", () => {
  withTempDir((tmpDir) => {
    const cwd = path.join(tmpDir, "cwd");
    writeJson(path.join(cwd, ".claude", "settings.json"), { slowDownPacing: { workMinutes: 0 } });

    const cfg = resolveConfig({ NODE_ENV: "production" }, { homeDir: path.join(tmpDir, "home"), cwd });
    assert.equal(cfg.disabled, true);
    assert.ok(typeof cfg.noticeReason === "string" && cfg.noticeReason.length > 0);
    assert.equal(cfg.workMs, DEFAULT_CONFIG.workMs);
  });
});

test("Case 12 (qodo PR #7): an unreadable settings location (directory) poisons the config — never silent defaults", () => {
  withTempDir((tmpDir) => {
    const dirAsSettings = path.join(tmpDir, "as-dir");
    fs.mkdirSync(dirAsSettings);
    const cfg = resolveConfig({
      NODE_ENV: "test",
      SLOW_DOWN_PROJECT_SETTINGS: dirAsSettings,
    });
    assert.equal(cfg.disabled, true, "exists-but-unreadable must fail safe to disabled");
    assert.ok(
      typeof cfg.noticeReason === "string" && cfg.noticeReason.includes("Failed to read"),
      `reason should name the read failure (got: ${cfg.noticeReason})`,
    );
  });
});

test("Case 12 & 13: Minutes convert to ms and resolveConfig accepts explicit env object without process.env mutation", () => {
  withTempDir((tmpDir) => {
    const projPath = path.join(tmpDir, "project.json");
    writeJson(projPath, {
      slowDownPacing: {
        workMinutes: 12.5,
        pauseMinutes: 1.5,
      },
    });

    const customEnv = {
      NODE_ENV: "test",
      SLOW_DOWN_PROJECT_SETTINGS: projPath,
    };

    const cfg = resolveConfig(customEnv);
    assert.equal(cfg.workMs, 12.5 * 60000);
    assert.equal(cfg.pauseMs, 1.5 * 60000);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  workMs: 5 * 60_000,
  pauseMs: 4 * 60_000,
});

function isPositiveFiniteNumber(val) {
  return typeof val === "number" && Number.isFinite(val) && val > 0;
}

function loadLayer(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { present: false, poisoned: false, obj: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { present: false, poisoned: false, obj: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      present: true,
      poisoned: true,
      reason: `Failed to parse settings JSON file at ${filePath}`,
      obj: null,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      present: true,
      poisoned: true,
      reason: `Settings JSON at ${filePath} is not a plain object`,
      obj: null,
    };
  }

  if (!("slowDownPacing" in parsed)) {
    return { present: true, poisoned: false, obj: null };
  }

  const pacing = parsed.slowDownPacing;
  if (!pacing || typeof pacing !== "object" || Array.isArray(pacing)) {
    return {
      present: true,
      poisoned: true,
      reason: `slowDownPacing in ${filePath} is not a plain object`,
      obj: null,
    };
  }

  return {
    present: true,
    poisoned: false,
    obj: pacing,
  };
}

/**
 * Resolves the two settings-file locations (FR-005, data-model §1).
 *
 * Test seam (production-inert, contract §3): under NODE_ENV=test,
 * SLOW_DOWN_GLOBAL_SETTINGS / SLOW_DOWN_PROJECT_SETTINGS override a layer;
 * a layer left unset in test mode resolves to null (no file) so tests can
 * never leak onto the developer's real settings.
 *
 * Production ALWAYS reads the real locations: ~/.claude/settings.json and
 * <cwd>/.claude/settings.json (the hook's cwd is the project directory).
 * Review F1 (phase 5): the seams must OVERRIDE path resolution, never
 * replace it — otherwise user configuration is dead code outside tests.
 */
export function resolveSettingsPaths(env = process.env, homeDir = os.homedir(), cwd = process.cwd()) {
  if (env && env.NODE_ENV === "test") {
    return {
      globalPath: env.SLOW_DOWN_GLOBAL_SETTINGS || null,
      projectPath: env.SLOW_DOWN_PROJECT_SETTINGS || null,
    };
  }
  return {
    globalPath: path.join(homeDir, ".claude", "settings.json"),
    projectPath: path.join(cwd, ".claude", "settings.json"),
  };
}

export function resolveConfig(env = process.env, { homeDir, cwd } = {}) {
  const { globalPath, projectPath } = resolveSettingsPaths(env, homeDir, cwd);

  const projectLayer = loadLayer(projectPath);
  const globalLayer = loadLayer(globalPath);

  let poisoned = false;
  let noticeReason = null;

  if (projectLayer.poisoned) {
    poisoned = true;
    noticeReason = projectLayer.reason;
  }
  if (globalLayer.poisoned && !noticeReason) {
    poisoned = true;
    noticeReason = globalLayer.reason;
  }

  const sources = {
    workMinutes: "default",
    pauseMinutes: "default",
  };

  const rawValues = {
    workMinutes: 5,
    pauseMinutes: 4,
  };

  const keys = ["workMinutes", "pauseMinutes"];

  for (const key of keys) {
    let definedLayer = null;
    let definedVal = undefined;

    if (projectLayer.obj && key in projectLayer.obj) {
      definedLayer = "project";
      definedVal = projectLayer.obj[key];
    } else if (globalLayer.obj && key in globalLayer.obj) {
      definedLayer = "global";
      definedVal = globalLayer.obj[key];
    }

    if (definedLayer !== null) {
      sources[key] = definedLayer;
      if (!isPositiveFiniteNumber(definedVal)) {
        poisoned = true;
        if (!noticeReason) {
          noticeReason = `Invalid ${key} value at ${definedLayer} layer: ${JSON.stringify(definedVal)}`;
        }
      } else {
        rawValues[key] = definedVal;
      }
    }
  }

  if (poisoned) {
    return {
      workMs: DEFAULT_CONFIG.workMs,
      pauseMs: DEFAULT_CONFIG.pauseMs,
      sourcePerKey: sources,
      disabled: true,
      noticeReason: noticeReason || "Configuration invalid",
    };
  }

  return {
    workMs: rawValues.workMinutes * 60_000,
    pauseMs: rawValues.pauseMinutes * 60_000,
    sourcePerKey: sources,
    disabled: false,
    noticeReason: null,
  };
}

---
description: Enable slow-down pacing for future sessions/exchanges
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
node --input-type=module -e "import { writePending } from '${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs'; import { resolveConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs'; const ok = writePending({ action: 'enable', requestedAt: Date.now() }); if (!ok) { console.error('Slow-down pacing: error enabling pacing (data dir unresolvable).'); process.exit(1); } const c = resolveConfig(); if (c.disabled) { console.error(\`Slow-down pacing: enable intent recorded, but the configuration is INVALID — pacing will NOT run until it is fixed. \${c.noticeReason}\`); process.exit(1); } console.log(\`Slow-down pacing: enabling. Work: \${c.workMs / 60000} min, pause: \${c.pauseMs / 60000} min per cycle. Pacing begins after your next exchange.\`);"

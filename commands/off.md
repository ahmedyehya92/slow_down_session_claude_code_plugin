---
description: Disable slow-down pacing for future sessions/exchanges
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
node --input-type=module -e "const DATA_DIR = '${CLAUDE_PLUGIN_DATA}'; import { writePending } from '${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs'; const ok = writePending({ action: 'disable', requestedAt: Date.now() }, { CLAUDE_PLUGIN_DATA: DATA_DIR }); if (!ok) { console.error('Slow-down pacing: error disabling pacing (data dir unresolvable).'); process.exitCode = 1; } else { console.log('Slow-down pacing: disabling. Any in-progress pause will complete naturally.'); }"

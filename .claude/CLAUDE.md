## Delegation Rules For Internet Search, Research and Deep Research

### Research Routing
**INSTRUCTION FOR CLAUDE CODE:**
Route all internet search, research, and deep research tasks to the `agy` command via your Bash tool — it is better at search. Do not consume your own token window on this.

**Never assume. Never answer from memory or guesswork.** If a task involves current facts, external data, or anything not 100% certain from context, you must search using `agy` first — no exceptions, no "I already know this."

#### Execution Syntax
Always run the Antigravity CLI in skip-permissions, non-interactive mode using `--dangerously-skip-permissions -p`, passing your search prompt.

Example:
```bash
agy --dangerously-skip-permissions -p "{PROMPT}"
```
# Orchestrator Guide — Driving Archon with OpenClaw

This document teaches an orchestrator (such as OpenClaw) how to drive Archon's Claude Code workflow. After reading this file, the orchestrator should be able to flexibly schedule plan, prover, and review stages without relying on the fixed `archon-loop.sh` pipeline.

## Core Principle

The orchestrator does **not** start interactive Claude Code sessions and improvise. Instead, it assembles prompts from Archon's framework and invokes `claude -p` with those prompts. The orchestrator decides **what stage to run next** and **which prompt to compose**, then drives the route.

---

## 0. Prerequisites — Verify Init

Before running any stage, the orchestrator must verify that the project has been initialized. Check for these files in the project directory:

```bash
test -f .archon/PROGRESS.md && test -d .archon/prompts && test -L .claude/skills/archon-lean4
```

If any are missing, the project has not been initialized. Run init first:

```bash
cd /path/to/Archon
./init.sh /path/to/lean-project
```

Do not invoke Claude Code with Archon prompts until these files exist — the prompts reference state files and skills that init creates.

---

## 1. How to Invoke Claude Code

### Command Template

```bash
cd <project-directory>
claude -p "<prompt>" \
    --dangerously-skip-permissions --permission-mode bypassPermissions \
    --model claude-opus-4-6
```

**Critical rules:**
- Always `cd` into the project directory first — Claude Code must see `.claude/skills/` and `.archon/` in its working directory
- Never add `--verbose` — it disables the TUI entirely
- Never add `--resume` unless explicitly recovering a crashed session
- The prompt is a single string; compose it by reading Archon's prompt files and injecting project-specific context

### What Each Invocation Produces

Each `claude -p` call is a self-contained session. It starts, executes the prompt, and exits. The orchestrator reads the state files afterward to decide the next step.

---

## 2. Available Stages and Prompts

Archon provides these prompt files in `<project>/.archon/prompts/` (symlinked from `.archon-src/prompts/`):

| Stage | Prompt File | Agent Role |
|-------|-------------|------------|
| Plan | `plan.md` | Read results, set objectives, prepare informal content |
| Prover (autoformalize) | `prover-autoformalize.md` | Scaffold Lean declarations from informal math |
| Prover (prover) | `prover-prover.md` | Fill `sorry` placeholders with proofs |
| Prover (polish) | `prover-polish.md` | Golf, refactor, extract reusable lemmas |
| Review | `review.md` | Analyze prover log, write proof journal |

### Composing a Prompt

Read the relevant prompt file and prepend context. Example for the plan agent:

```
You are the plan agent for project '<name>'. Current stage: prover.
Project directory: /path/to/project
Project state directory: /path/to/project/.archon
You are the plan agent. Read .archon/CLAUDE.md for project context, then read .archon/prompts/plan.md for your full instructions and .archon/PROGRESS.md for current objectives.
All state files (PROGRESS.md, task_pending.md, task_done.md, USER_HINTS.md, task_results/) are in .archon/.
The .lean files are in /path/to/project/.
```

The orchestrator constructs this string, reads the prompt file content if needed, and passes the assembled prompt to `claude -p`.

---

## 3. State Files the Orchestrator Reads

All state is in `<project>/.archon/`:

| File | Written By | What It Contains |
|------|-----------|-----------------|
| `PROGRESS.md` | Plan agent | Current stage, objectives, summary |
| `task_pending.md` | Plan agent | Per-theorem attempt history, dead ends |
| `task_done.md` | Plan agent | Resolved theorems |
| `task_results/<file>.md` | Prover agent(s) | Raw prover output per file |
| `USER_HINTS.md` | User | Strategic guidance for plan agent |
| `PROJECT_STATUS.md` | Review agent | Cumulative progress, blockers, patterns |
| `proof-journal/sessions/session_N/` | Review agent | Per-iteration journal |

### Reading the Current Stage

```bash
awk '/^## Current Stage/{getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' .archon/PROGRESS.md
```

Returns: `init`, `autoformalize`, `prover`, `polish`, or `COMPLETE`.

### Checking Sorry Count

Use the `sorry_analyzer.py` script bundled with Archon's lean4 skills:

```bash
python3 <archon>/.archon-src/skills/lean4/lib/scripts/sorry_analyzer.py <project> --format=summary
```

This properly parses Lean syntax (excludes comments, handles multi-line constructs) and reports sorry count per file with context.

---

## 4. Decision Logic — What to Run Next

The orchestrator replaces `archon-loop.sh`'s fixed cycle with adaptive scheduling:

### Standard Sequence (baseline)

```
Plan → Prover → Review → Plan → Prover → Review → ...
```

### Adaptive Decisions

The orchestrator should read state files and decide:

These are examples, not rigid rules — the orchestrator should use its own judgment:

| Condition | Typical Action |
|-----------|----------------|
| First run / no PROGRESS.md | Run Plan to initialize objectives |
| `task_results/` has new files | Run Plan to collect results before next prover round |
| PROGRESS.md has clear objectives, no new results | Run Prover |
| Prover just finished (log exists, no review yet) | Run Review, then run Plan |
| Sorry count unchanged after prover | Re-run Plan or Prover with modified prompt (add hints, suggest alternative approaches) |
| Sorry count is 0 | Run Plan to verify and advance stage (prover → polish) |
| Stage is `COMPLETE` | Stop |
| Multiple prover rounds with no progress | Modify the prompt: add mathematical hints, suggest decomposition, or change the prover's strategy |
| Review shows remaining targets are very difficult | Orchestrator decides: try harder, decompose differently, or escalate to user |

### Steering via Prompt Modification

The orchestrator should **not** write to `USER_HINTS.md` — that file is for the human user. Instead, the orchestrator injects guidance directly into the prompt it composes for `claude -p`. For example, when the prover is stuck:

```
You are the prover agent for project '<name>'. Current stage: prover.
...
Read .archon/prompts/prover-prover.md for your full instructions.

ADDITIONAL CONTEXT FROM ORCHESTRATOR:
- Theorem X: stop trying approach Y, it failed 3 times. Try induction on n instead.
- Prioritize file Z — it blocks three other files.
- For lemma W, the key insight is Finset.sum_comm.
```

This keeps `USER_HINTS.md` reserved for the human user and gives the orchestrator full control over what each agent sees.

---

## 5. Skills and Prompts

### Default rule: do not touch

Do **not** modify any Archon skills or prompts unless the user explicitly asks. Without a user request, leave all prompt files and skill directories unchanged.

### Temporary guidance (preferred for most situations)

If the user wants to steer the Archon agent's behavior for this run or this iteration, use **temporary** methods that are not persisted by Archon:

- **Append to the assembled prompt** — inject instructions into the prompt string you pass to `claude -p` (see Section 4, "Steering via Prompt Modification"). This affects only the current invocation.
- **Add `/- USER: ... -/` comments** in `.lean` files — these are visible to the prover agent that owns that file. They persist in the source but are not part of Archon's configuration.

These are ephemeral interventions. Prefer them over editing files.

### Persistent changes (only when the user requests)

If the user wants lasting changes to how Archon agents work, they may ask you to edit skills and prompts. Before making any persistent change, understand the distinction:

- **Skills** describe what to do in specific situations — they are reusable workflows or domain-specific strategies that Claude Code can invoke (e.g., a decomposition strategy for a class of theorems).
- **Prompts** shape the overall workflow and instructions — how the plan agent sets objectives, how the prover approaches proofs, how the review agent analyzes sessions.

**Priority of intervention** — when the user asks for a change, prefer the least invasive option:

1. **Add or extend a local skill** (`<project>/.claude/skills/<name>/SKILL.md`) — best for new reusable workflows
2. **Adjust a local prompt** (`<project>/.archon/prompts/*.md`) — best for changing agent behavior or adding rules
3. **Adjust Archon's lean4 skills** — only when appropriate, and only locally (never through the global symlink)

### Global vs. Local

| Layer | Prompts | Skills |
|-------|---------|--------|
| **Global** | `<archon>/.archon-src/prompts/*.md` | `<archon>/.archon-src/skills/*/` |
| **Local** | `<project>/.archon/prompts/*.md` | `<project>/.claude/skills/*/` |

- **Global** changes affect every project that uses this Archon installation. Only make global changes if the user explicitly intends to change behavior for all projects.
- **Local** changes affect only one project. Local prompts are symlinks to global by default; replacing a symlink with a real file creates a local override.
- Local always takes precedence over global.

### How to edit a local prompt

Local prompts live in `<project>/.archon/prompts/`. By default they are symlinks to the global versions. To override one:

**Step 1: Replace the symlink with a real file**
```bash
cd /path/to/project
# Check if it's still a symlink
ls -la .archon/prompts/prover-prover.md
# Copy the original content, removing the symlink
cp --remove-destination "$(readlink .archon/prompts/prover-prover.md)" .archon/prompts/prover-prover.md
```

**Step 2: Append new instructions — do not rewrite existing content**

The prompt files have a defined structure that the agents rely on. Always append new sections at the end. Example: the user reports that the prover keeps trying `ring` on goals where `simp` would work. Add a learned-rules section:

```markdown
## Project-Specific Rules (added by orchestrator)

### Tactic preferences for this project
- On algebraic simplification goals, try `simp [mul_comm, mul_assoc]` before `ring`.
- When `ring` fails on goals involving `Finset.sum`, decompose with `Finset.sum_congr` first.

### Dead ends to avoid
- Do not attempt to use `Polynomial.roots` on multivariate polynomials — Mathlib's `roots` is univariate only.
- Theorem `foo_bar_lemma` cannot be proved via `apply?` — the instance search diverges. Use `exact` with the explicit term instead.
```

**Step 3: Verify the file is no longer a symlink**
```bash
ls -la .archon/prompts/prover-prover.md
# Should show a regular file, not a symlink (no -> arrow)
```

**What each prompt file controls:**

| File | What to add here |
|------|-----------------|
| `plan.md` | How the plan agent sets objectives, what it should prioritize, how it should decompose tasks |
| `prover-prover.md` | Proof tactics to prefer/avoid, how to handle missing Mathlib lemmas, decomposition strategies |
| `prover-autoformalize.md` | How to translate informal math to Lean declarations, naming conventions, import patterns |
| `prover-polish.md` | Golfing preferences, refactoring rules, when to extract helper lemmas |
| `review.md` | What the review agent should focus on, how detailed the journal should be |

### How to create a local skill

Skills are directories under `<project>/.claude/skills/` with a `SKILL.md` file inside. Claude Code discovers them automatically.

**Example: a skill for a specific decomposition strategy**

The user's project involves many goals about continuous functions on compact sets. The prover keeps reinventing the same decomposition. Create a skill to codify the pattern:

```bash
mkdir -p .claude/skills/compact-continuous-decompose
```

Write `.claude/skills/compact-continuous-decompose/SKILL.md`:

```markdown
---
name: compact-continuous-decompose
description: Decompose goals about continuous functions on compact sets into standard sub-lemmas
user_invocable: true
---

# Compact-Continuous Decomposition

When facing a goal that involves a continuous function on a compact set, decompose as follows:

## Step 1: Extract compactness
- Use `IsCompact.exists_forall_le` or `IsCompact.exists_forall_ge` to get extrema.
- If the goal involves uniform continuity, apply `IsCompact.uniformContinuous_of_continuous`.

## Step 2: Reduce to finite subcovers
- Apply `IsCompact.elim_finite_subcover` when the goal involves an open cover.
- Use `IsCompact.finite` when working with discrete subsets.

## Step 3: Combine
- After extracting the finite witnesses, the remaining goal is typically a `Finset` computation.
- Prefer `Finset.sup` / `Finset.inf` over manual case splits.

## Key Mathlib lemmas
- `IsCompact.exists_forall_le`
- `IsCompact.elim_finite_subcover`
- `CompactSpace.isCompact_univ`
- `Continuous.comp_isCompact`
```

This skill is now available as `/compact-continuous-decompose` in the next Claude Code session. The prover can invoke it when facing relevant goals.

**Example: a skill for handling a project-specific algebraic structure**

The project defines a custom algebraic structure `WLocal` that appears in many theorems. Create a skill that teaches the prover how to work with it:

```bash
mkdir -p .claude/skills/wlocal-guide
```

Write `.claude/skills/wlocal-guide/SKILL.md`:

```markdown
---
name: wlocal-guide
description: Guide for working with WLocal rings in this project
user_invocable: true
---

# Working with WLocal Rings

## What is WLocal
`WLocal` is defined in `Algebra/WLocal.lean`. It is a ring that is local after weak localization.
Key fields: `isLocal_weakLocalization`, `henselian`.

## Common patterns
- To show a ring is WLocal, first show it is Henselian (`RingHom.Henselian`), then show weak localization preserves locality.
- The key lemma is `WLocal.of_henselian_surjective` — use it when you have a surjective map from a Henselian ring.

## Pitfalls
- Do NOT try to unfold `WLocal` directly — work through the API (`WLocal.isLocal`, `WLocal.henselian`).
- `WLocal.prod` requires both factors to be WLocal. The proof uses `RingHom.BijectiveOnStalks.prod` from `Algebra/StalkIso.lean`.

## Useful Mathlib lemmas
- `IsLocalRing.of_surjective`
- `Henselian.tfae`
- `IsLocalization.mk'_surjective`
```

### How to extend an existing skill

If an existing local skill needs updating (e.g., the orchestrator learned a new pattern), edit its `SKILL.md` directly:

```bash
# Append a new section to an existing skill
cat >> .claude/skills/compact-continuous-decompose/SKILL.md << 'EOF'

## Additional pattern: equicontinuity (added after session 5)
When the goal involves a family of continuous functions on a compact set:
- Use `CompactSpace.isCompact_univ` + `Equicontinuous.closure` to reduce to pointwise convergence.
- Key lemma: `equicontinuous_of_continuousOn_compact`.
EOF
```

### Skills with supporting files

A skill can include supporting files alongside `SKILL.md`. Claude Code can read them when the skill is invoked:

```
.claude/skills/my-strategy/
├── SKILL.md              # Main skill definition (required)
├── examples.lean         # Example Lean code showing the pattern
├── references.md         # Mathematical background or paper excerpts
└── tactics-cheatsheet.md # Quick reference for relevant tactics
```

Reference supporting files from `SKILL.md`:
```markdown
See `examples.lean` in this directory for worked examples.
See `references.md` for the mathematical background from [Paper X].
```

### Encouraging improvement over time

When you or the user notice recurring patterns — mistakes the prover keeps making, strategies that consistently work, or dead ends that keep being re-explored — suggest to the user that you update skills or prompts so the system learns from those patterns. The goal is that over time, the project's local prompts and skills accumulate the lessons learned, and future iterations avoid known pitfalls.

Be deliberate: edits to skills and prompts strongly affect Archon's behavior. Keep changes minimal, append rather than rewrite, and always explain to the user what you changed and why.

### Rules summary

| Situation | Method | Persisted? |
|-----------|--------|-----------|
| One-off steering for this iteration | Append to assembled prompt | No |
| File-specific proof hint | `/- USER: ... -/` comment | In source file only |
| User asks for lasting behavior change | Edit local prompt or create local skill | Yes |
| Recurring pattern worth learning | Suggest to user, then edit with permission | Yes |
| Never | Edit through global symlink or modify Archon installation | — |

---

## 6. Running the Review Stage

Review requires a log file from the prover run. The orchestrator should:

1. **Extract attempt data** (deterministic, no LLM):
```bash
python3 <archon>/scripts/extract-attempts.py <log-file> .archon/proof-journal/current_session/attempts_raw.jsonl
```

2. **Run the review agent**:
```bash
claude -p "You are the review agent for project '<name>'. Current stage: <stage>.
Project directory: <path>
Project state directory: <path>/.archon
Read .archon/CLAUDE.md for your role, then read .archon/prompts/review.md.
Session number: <N>.
Pre-processed attempt data: .archon/proof-journal/current_session/attempts_raw.jsonl (READ THIS FIRST).
Prover log: <log-file>
Write your output to: .archon/proof-journal/sessions/session_<N>/" \
    --dangerously-skip-permissions --permission-mode bypassPermissions
```

3. **Validate output**:
```bash
python3 <archon>/scripts/validate-review.py .archon/proof-journal/sessions/session_<N> .archon/proof-journal/current_session/attempts_raw.jsonl
```

---

## 7. Failure Patterns and Recovery

### Claude Code Gives Up Too Early

**Pattern**: Prover reports "Mathlib lacks infrastructure" or "proof would be too long" and stops.

**Response**: Inject guidance directly into the next prompt:
```
ADDITIONAL CONTEXT FROM ORCHESTRATOR:
Do not accept "Mathlib lacks X" as a reason to leave sorry.
For theorem Y: prove the missing lemma yourself, or find an alternative approach.
Use Web Search to find the paper proof if needed.
```

### Claude Code Doesn't Use Web Search

**Pattern**: When blueprint references a paper theorem, Claude Code searches Mathlib, finds nothing, and gives up — without searching the web for the paper.

**Response**: This is already addressed in the prover prompt, but can be reinforced by adding explicit instructions in the orchestrator's prompt.

### Session Produces No Output

**Pattern**: `claude -p` exits but `task_results/` is empty.

**Response**: Check the log file for errors. Common causes:
- API authentication failure → check `ANTHROPIC_API_KEY` / proxy config
- MCP server not running → run `/archon-lean4:doctor` to diagnose

---

## 8. Parallel Prover Scheduling

The orchestrator can run multiple provers in parallel by assigning each a different file:

```bash
# Find files with sorry (using sorry_analyzer from lean4 skills)
SORRY_FILES=$(python3 <archon>/.archon-src/skills/lean4/lib/scripts/sorry_analyzer.py <project> --format=json \
    | python3 -c "import sys,json; print('\n'.join(sorted(set(s['file'] for s in json.load(sys.stdin)))))")

# Launch one prover per file in parallel
for file in $SORRY_FILES; do
    rel=$(python3 -c "import os; print(os.path.relpath('$file', '<project>'))")
    claude -p "You are a prover agent for project '<name>'. Current stage: prover.
...
Your assigned file: $rel
You own ONLY this file. Do NOT edit any other .lean file.
Write your results to .archon/task_results/${rel}.md when done." \
        --dangerously-skip-permissions --permission-mode bypassPermissions &
done
wait
```

Each prover writes to its own `task_results/<file>.md`. The orchestrator then runs Plan to collect all results.

---

## 9. Cron and Heartbeat

The orchestrator should implement a cron loop:

### What to Check

| Check | How | Frequency |
|-------|-----|-----------|
| Process alive | `ps aux \| grep "claude -p"` | Every 5 min |
| Sorry count changing | `grep -r sorry *.lean` before/after | After each prover |
| Log growing | `wc -l <log-file>` | Every 10 min |
| Results written | `ls .archon/task_results/` | After prover finishes |

### What NOT to Do

- Do not send multiple messages to a running `claude -p` — it's non-interactive, single-prompt
- Do not restart after a single observation of no progress — allow at least 90 minutes before concluding a session is stuck
- Do not run `lake build` unless performing a final full-project check — use MCP diagnostics or `lake env lean <file>` for routine compilation checks

---

## 10. Logging

Each `claude -p` call can produce structured logs:

```bash
claude -p "<prompt>" \
    --dangerously-skip-permissions --permission-mode bypassPermissions \
    --verbose --output-format stream-json \
    2>/dev/null | tee <log-file>
```

The log file can then be fed to `extract-attempts.py` for the review stage.

---

## 11. Complete Example: One Iteration

```bash
PROJECT=/path/to/lean-project
ARCHON=/path/to/Archon
STATE=$PROJECT/.archon
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
STAGE=$(awk '/^## Current Stage/{getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' $STATE/PROGRESS.md)
cd $PROJECT

# 1. Plan
claude -p "You are the plan agent for project '$(basename $PROJECT)'. Current stage: $STAGE.
Project directory: $PROJECT
Project state directory: $STATE
Read $STATE/CLAUDE.md for project context, then read $STATE/prompts/plan.md for your full instructions and $STATE/PROGRESS.md for current objectives.
All state files are in $STATE/. The .lean files are in $PROJECT/." \
    --dangerously-skip-permissions --permission-mode bypassPermissions

# 2. Prover (re-read stage — plan may have changed it)
STAGE=$(awk '/^## Current Stage/{getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' $STATE/PROGRESS.md)
PROVER_LOG=$STATE/logs/prover-${TIMESTAMP}.jsonl
claude -p "You are the prover agent for project '$(basename $PROJECT)'. Current stage: $STAGE.
Project directory: $PROJECT
Project state directory: $STATE
Read $STATE/CLAUDE.md for project context, then read $STATE/prompts/prover-${STAGE}.md for your full instructions and $STATE/PROGRESS.md for current objectives.
All state files are in $STATE/. The .lean files are in $PROJECT/." \
    --dangerously-skip-permissions --permission-mode bypassPermissions \
    --verbose --output-format stream-json 2>/dev/null > $PROVER_LOG

# 3. Review (analyze prover log only, not plan)
MAX_N=0
for d in $STATE/proof-journal/sessions/session_*; do
    [ -d "$d" ] || continue
    n="${d##*session_}"; [ "$n" -gt "$MAX_N" ] 2>/dev/null && MAX_N=$n
done
SESSION_NUM=$((MAX_N + 1))
SESSION_DIR=$STATE/proof-journal/sessions/session_$SESSION_NUM
mkdir -p $SESSION_DIR $STATE/proof-journal/current_session

python3 $ARCHON/scripts/extract-attempts.py $PROVER_LOG $STATE/proof-journal/current_session/attempts_raw.jsonl

claude -p "You are the review agent for project '$(basename $PROJECT)'. Current stage: $STAGE.
Project directory: $PROJECT
Project state directory: $STATE
Read $STATE/CLAUDE.md for project context, then read $STATE/prompts/review.md for your full instructions.
Session number: $SESSION_NUM.
Pre-processed attempt data: $STATE/proof-journal/current_session/attempts_raw.jsonl (READ THIS FIRST).
Prover log: $PROVER_LOG
Write your output to: $SESSION_DIR/" \
    --dangerously-skip-permissions --permission-mode bypassPermissions

python3 $ARCHON/scripts/validate-review.py $SESSION_DIR $STATE/proof-journal/current_session/attempts_raw.jsonl

# 4. Check if done
NEW_STAGE=$(awk '/^## Current Stage/{getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' $STATE/PROGRESS.md)
echo "Stage after iteration: $NEW_STAGE"
```

---

## 12. Key Operational Rules

1. **One message per session** — `claude -p` takes exactly one prompt and runs to completion. You cannot inject follow-up messages.
2. **Read state, then decide** — always read `PROGRESS.md`, `task_results/`, and `PROJECT_STATUS.md` before choosing the next stage.
3. **Prompt modification is your steering wheel** — inject context and hints directly into the prompt you compose for `claude -p`. Do not write to `USER_HINTS.md` — that is reserved for the human user.
4. **Review is your eyes** — `PROJECT_STATUS.md` and `proof-journal/` are how the orchestrator understands what happened. Always run review after prover.
5. **Don't fight Claude Code** — if the model gives up on a theorem, don't re-run the same prompt. Write hints with alternative strategies, decompose the problem, or provide informal proof sketches.
6. **Sorry count is ground truth** — don't trust agent self-reports. Always verify via `sorry_analyzer.py`.
7. **Patience** — a single prover session can run for hours. This is normal for project-level formalization. Only intervene after 90+ minutes of zero progress (verified by log growth, not thinking time).

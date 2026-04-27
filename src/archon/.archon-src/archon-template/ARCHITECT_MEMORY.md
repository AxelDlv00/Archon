# Architect Memory

Persistent memory for the architect (Phase 0) agent. Read every iteration before acting; append to it at the end of every iteration.

Entries are grouped by section. Within a section, newest entries go at the bottom. Old entries are **superseded**, not deleted, so the reasoning history is preserved.

---

## General observations

Long-lived patterns about how the Archon agents behave on this project. Each entry:

```
### <short title>  (added: session_<N>, status: active|superseded)
- **Observation:** one or two sentences
- **Evidence:** session(s) / file(s) / failure that prompted this
- **Action taken:** "edited prompts/plan.md §X" / "no action, monitoring" / "proposal to mathematician"
```

<!-- Example (delete once real entries exist):
### Prover weakens hypotheses to close goals  (added: session_3, status: active)
- **Observation:** When stuck, the prover silently drops a hypothesis from the statement instead of reporting the blocker.
- **Evidence:** session_3 milestones for Algebra/WLocal.lean; prover rewrote `h : IsPrime p` to `h : Prime p` without flagging.
- **Action taken:** added a "Never weaken the statement silently" paragraph to prompts/prover-prover.md.
-->

---

## Cause → consequence

Directives the architect has injected into execution prompts, paired with the downstream effect observed in later iterations. Each entry:

```
### <prompt file> — <short title>  (injected: session_<N>, status: active|superseded)
- **Rule injected:** quoted or paraphrased
- **Reason:** what was failing that motivated it
- **Observed effect:** what happened in the following sessions
- **Keep / revise / remove:** current recommendation
```

<!-- Example (delete once real entries exist):
### prompts/plan.md — require informal sketch before prover call  (injected: session_5, status: active)
- **Rule injected:** "Before assigning a prover task, ensure the blueprint chapter has a step-by-step proof sketch."
- **Reason:** provers were giving up on references like "by Hiblot 1975" with no content in the chapter.
- **Observed effect:** session_6 / session_7: fewer early-stop reports, chapters now have sketches.
- **Keep / revise / remove:** keep.
-->

---

## Open proposals to the mathematician

Changes the architect believes are needed but cannot make itself (edits to `USER_STEERING.md`, `CLAUDE.md`, `archon-protected.yaml`, or `architect.md`). The mathematician reviews these manually.

```
### <short title>  (raised: session_<N>)
- **What to change:** which file, which section
- **Why:** the evidence
- **Suggested wording:** optional
```

---

## Iteration log

One entry per architect run, appended at the end of the run. Newest at the bottom.

```
### session_<N> — <ISO date>
- **Edited:** list of files (or "none")
- **Rationale:** one sentence per edit
- **Deferred:** references to "Open proposals" entries raised this iteration
```

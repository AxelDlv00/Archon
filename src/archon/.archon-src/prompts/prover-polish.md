# Prover — Polish Stage

You are the prover agent in the polish stage. Your job: verify, clean, and improve compiled proofs, and mark the blueprint as fully formalized.

## Workflow

1. Read `PROGRESS.md` for your current objectives (read only — do not edit it)
2. **Read your blueprint chapter** — `blueprint/src/chapters/<your_slug>.tex` — to understand the intended proof structure. Your polishing should preserve the alignment between Lean proofs and the chapter's blueprint labels.
3. Read `task_pending.md` for context from prior sessions
4. Check your `.lean` file for `/- USER: ... -/` comments for file-specific hints
5. Verify compilation and confirm absence of `sorry`, `axiom`, and other escape hatches
6. Perform code quality improvements:
   - Golf proofs for brevity and clarity (`/lean4:golf`)
   - Refactor to leverage Mathlib (`/lean4:refactor`)
   - Extract reusable helpers from long proofs
7. Verify compilation after each change
8. Update the blueprint markers (see "Blueprint markers" below)
9. Write results to `task_results/<your_file>.md`

**Write permissions**: You may only write to your assigned `.lean` file(s), your `task_results/<file>.md`, and your blueprint chapter (only `\leanok` markers and `% NOTE:` comments — do not rewrite the plan agent's sketches). Do NOT edit `PROGRESS.md`, `task_pending.md`, or other agents' files.

## Blueprint markers

By the time you reach polish stage, most `\begin{theorem}` blocks should already have `\leanok` from the prover stage. Your job in polish is to verify this is still accurate and, where proofs are now also complete, add `\leanok` to the corresponding `\begin{proof}` block.

Two markers to check per declaration:

- `\leanok` inside `\begin{theorem}` / `\begin{lemma}` — the **statement** is formalized. Should already be there.
- `\leanok` inside `\begin{proof}` — the **proof** is fully formalized in Lean. Add this now if the proof compiles with no `sorry`.

When both markers are present for a declaration, the blueprint dependency graph will render the node as "fully proved" (the dark-green color in the default color scheme). That is the signal the plan agent uses to decide whether polish is complete.

Also use this stage to catch stale markers — if the prover stage added `\leanok` to a theorem whose Lean name has since been renamed or whose statement has drifted, fix the `\lean{...}` line and re-verify.

## Constraints

- Do NOT introduce new `sorry` or axioms
- Do NOT modify initial definitions or final theorem/lemma statements
- Proof bodies and intermediate helpers may be freely improved
- Keep edits minimal: do not delete comments or change labels
- Verify compilation after each change
- Do NOT rewrite blueprint prose — the informal proof sketches stay as the plan agent wrote them. Only markers and `% NOTE:` comments are yours to add.

## Logging

Record polish work in `task_results/<your_file>.md`. Add a new `### Attempt N` entry for each optimization or issue found, and note which blueprint blocks now have both statement and proof `\leanok`.

```markdown
# Algebra/WLocal.lean

## wLocal_iff
### Polish pass
- **Golf**: reduced proof from 42 lines to 18 using `simp only`
- **Verified**: compiles, no sorries, no new axioms
- **Blueprint**: added `\leanok` to `\begin{proof}` block of `thm:wLocal_iff`

## helper_bijective
### Polish pass
- **Refactor**: extracted `PrimeSpectrum.comap_injective` argument into helper `spectrum_inj`
- **Verified**: compiles
- **Blueprint**: added `\leanok` to `\begin{proof}` of `lem:helper_bijective`

## Blueprint status
- 2/2 blocks in Algebra_WLocal.tex are now fully proved (both \leanok markers present).
```

## End-of-session handoff

Before you stop:

1. Verify the file still compiles (no sorries, no axioms).
2. For every theorem/lemma in your chapter, confirm that `\leanok` is present on both the statement and proof blocks, or note in `task_results` why it is not.
3. Write `task_results/<your_file>.md` summarizing what was polished and the current blueprint status.
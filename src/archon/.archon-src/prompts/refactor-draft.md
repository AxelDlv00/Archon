# Refactor Directive Drafting Interview

You are helping the mathematician draft a `REFACTOR_DIRECTIVE.md` for Archon's refactor agent. This is an **interactive session** — not an autonomous agent run. Ask the user questions, gather answers, and produce a well-formed directive.

Do **not** launch the refactor agent yourself. Your only output is the directive file.

## Where to write

Write the final directive to `.archon/REFACTOR_DIRECTIVE.md` in the project root.

## What to ask the user

Walk the user through the five required sections, one at a time. Do not move on until each answer is concrete enough for the refactor agent to act on.

1. **Problem statement** — In the user's own words, what is wrong with the current structure of the project? Which files or declarations are problematic? Why is this a refactor and not a proof-filling task?

2. **Mathematical justification** — Why is the proposed change mathematically correct? If the user isn't sure, help them: use `lean_leansearch` or `lean_loogle` to verify any Mathlib alignment, or search for relevant references. Do not accept hand-wave; the refactor agent needs to understand *why* each change is valid so it can fix cascading type mismatches.

3. **Concrete changes** — Which exact definitions, signatures, or file splits are proposed? For each change:
   - Old form (signature or definition)
   - New form
   - Affected files that will need updating
   
   If the user requests a **file split** (e.g. "`Algebra/WLocal.lean` is 2000 lines, split it"), propose the split: which declarations go into which new file, and what the new file names should be.

4. **Risk assessment** — List every declaration from `archon-protected.yaml` that this refactor will touch.
   - Which protected declarations will *move* (file path changes, name/signature preserved) — the refactor agent can do this and must update the YAML.
   - Which protected declarations would need to change name or signature — the refactor agent **cannot** do this. If any, ask the user to either unprotect them first (edit `archon-protected.yaml` themselves) or drop that part of the refactor.
   - Estimate how many downstream proofs will break into `sorry`.

5. **Rollback plan** — Record the current inner-git HEAD so the user can get back here if the refactor goes badly. Run `git --git-dir=.archon/.git --work-tree=. rev-parse --short HEAD` from the project root and include the SHA in the directive. Mention the command to roll back:
   ```
   archon checkout <branch-or-sha>   # after reviewing the diff
   ```

## Format of the written file

```markdown
# Refactor Directive

## Problem
<user's statement of the problem>

## Mathematical Justification
<argument for correctness of the change>

## Changes Requested
<concrete list, one bullet per change — precise enough for the refactor agent>

## Risk Assessment
### Protected declarations moved
- `path/before.lean::decl_name` → `path/after.lean::decl_name`
  (refactor agent will update archon-protected.yaml)

### Protected declarations requiring signature changes
- (none — or: user must unprotect these first)

### Expected downstream breakage
<approximate count of sorries that will appear>

## Rollback
- Before-refactor inner-git SHA: `<sha>`
- To revert: `archon checkout <sha-or-branch>`
```

## After writing

Summarize what you wrote and tell the user:

> Directive ready. Review `.archon/REFACTOR_DIRECTIVE.md` and edit if needed. When you're happy with it, run:
>
> `archon refactor run <path>`
>
> That will launch the refactor agent, which will execute the directive and commit its work to the inner git.

Do not launch the refactor agent. Stop after writing the file.

# Migrating to Archon v0.1.0

Archon v0.1.0 reworks installation and project setup around a single
`archon` CLI. This guide walks you through upgrading an existing Archon
install and, separately, an existing Archon-initialized project. If you are
starting from scratch, you don't need this file — follow the
[README](../README.md) instead.

## TL;DR

*It is always safer to backup your project before running a migration. We recommend committing all changes to git and pushing to a remote before starting. However, be aware that some files are gitignored by default (e.g. `.archon/`)*

1. **Reinstall** the tool with the new one-line installer.
2. **Re-run `archon init`** in each project that was initialized by an older
   version. When asked, pick **merge** (recommended) — Archon will walk you
   through the differences file by file with Claude Code's help.

Your project source files (`.lean`, papers, etc.) are never touched. Only
files inside `.archon/` and project-scope Claude Code registrations are
affected.

---

## 1. What changed

### 1.1 Installation: shell scripts → Python CLI

Previous versions shipped a collection of shell scripts (`archon-loop.sh`,
`init.sh`, `review.sh`, etc.) that you ran from a cloned checkout of the
repository. v0.1.0 replaces them with a single installable Python package
that exposes the commands below:

| Command | Description |
|---------|-------------|
| `archon init` | Initialize a new Archon project (or reconcile an existing one). |
| `archon loop` | Run the automated plan → prove → review loop. |
| `archon dashboard` | Start the web monitoring interface. |
| `archon doctor` | Verify the full Archon setup and health. |
| `archon prove` | Directly prove an inline statement. |
| `archon setup` | Install required system dependencies. |
| `archon update` | Update Archon to the latest published version. |

The install command is:

```bash
curl -sSL https://raw.githubusercontent.com/frenzymath/Archon/refs/heads/main/install.sh | bash
```

You no longer need to keep a clone of the Archon repository around to use
Archon. The package is installed into your Python environment and can be
updated with `archon update`.

### 1.2 Project layout: symlinks → copies

Previous versions populated `<project>/.archon/prompts/` with **symlinks
back to the Archon source checkout** and installed `lean4-skills` as a
symlinked cache. This meant:

- Changing a prompt in the Archon repo instantly affected every project.
- Deleting or moving the Archon checkout silently broke every project that
  was symlinked to it.

v0.1.0 uses **copies** instead. Each project gets its own independent copy
of the prompts, `CLAUDE.md`, the informal agent, and the skills plugin.
This removes the fragility and lets you safely edit prompts per-project,
but it also means template updates no longer propagate automatically — you
pull them in by re-running `archon init` and choosing **merge** or
**overwrite**.

### 1.3 Dashboard: manual → auto-launch

`archon loop` now launches the web dashboard in the background on a free
port in 8080–8099 by default and prints the URL. The dashboard keeps
running after the loop finishes so you can inspect results. Pass
`--no-dashboard` to disable, or `--open` to open a browser automatically.

### 1.4 Re-init is now safer

Running `archon init` on a project that was already initialized — by this
or an older version — no longer errors or overwrites your edits silently.
It detects the existing setup and offers four choices:

- **keep** — leave files alone; just refresh MCP / plugin registrations.
- **merge** *(recommended)* — launch Claude Code in a focused diff session
  and reconcile each prompt / `CLAUDE.md` file interactively.
- **overwrite** — replace all Archon files with the bundled versions
  (discards local edits to prompts and `CLAUDE.md`).
- **abort** — cancel without changes.

User state (`PROGRESS.md`, `USER_HINTS.md`, `task_pending.md`, `task_done.md`,
`proof-journal/`) is preserved in all non-abort modes.

### 1.5 MCP / plugin registration is self-healing

The old MCP registration pointed into the Archon source checkout. If you
moved or deleted that checkout, the MCP server would silently break.
`archon init` now:

- Removes any existing `archon-lean-lsp` registration and re-adds it with
  the current install's path.
- Detects when the `archon-local` plugin marketplace points at a stale
  path and updates it.
- Disables conflicting global `lean4-skills` / `lean-lsp` plugins **for
  this project only** — your other projects are untouched.

---

## 2. Upgrading the tool

You do not need to uninstall the old scripts first — they live in your cloned checkout and are inert once you stop running them.

### 2.1 Fresh install

If you never ran Archon via pip before:

```bash
curl -sSL https://raw.githubusercontent.com/frenzymath/Archon/refs/heads/main/install.sh | bash
```

This fetches the repository, runs `pip install .`, and executes
`archon setup` to install system dependencies. We recommend using a
dedicated virtual environment (e.g. `python -m venv ~/.venvs/archon &&
source ~/.venvs/archon/bin/activate`) before running the installer.

### 2.2 If you already installed a preview CLI build

If you installed one of the preview builds from the PR branch, update with:

```bash
archon update
```

This re-runs the installer against `main`.

### 2.3 Verify the install

```bash
archon --help
archon doctor
```

If `archon doctor` is happy, you're ready to migrate your projects.

---

## 3. Upgrading an existing project

Do this for each project where you previously ran the old `init.sh`.

### 3.1 Before you start

**Backup, commit and push your project.** Both the recommended merge flow and the
fallback overwrite flow only touch `.archon/` and your project-scope Claude
Code registrations, not your `.lean` files — but you should have a clean
checkpoint anyway before running any tool that edits project state.

```bash
cd /path/to/your-lean-project
cp -r .archon/ .archon-backup/
git add .
git commit -m "Backup before Archon CLI migration"
git push
```

If you have customizations under `.archon/prompts/` or in `.archon/CLAUDE.md`
that you want to keep, be aware that currently `.archon/` is gitignored.

### 3.2 Run `archon init`

```bash
archon init /path/to/your-lean-project
```

Archon detects the existing setup and prints something like:

```
⚠ This project has already been initialized with Archon.
  Detected layout:        legacy-symlink
  Current stage:          prover
  Prompts are symlinks:   yes

Detected the legacy symlink-based layout. The new CLI copies prompts
into .archon/prompts/ instead of symlinking. Re-initializing directly
would break the old symlinks.

How would you like to proceed?
  [k] keep
  [m] merge      (recommended)
  [o] overwrite
  [a] abort
```

The right choice depends on what you've edited:

| Situation | Choose |
|-----------|--------|
| You never edited anything under `.archon/prompts/` or `.archon/CLAUDE.md`. | **overwrite** |
| You edited some prompts and want to review the differences. | **merge** |
| You want to keep your current setup and only refresh registrations. | **keep** |
| You are not sure. | **merge** |

### 3.3 The merge flow in detail

When you pick `merge`, Archon:

1. Copies the new bundled prompts and `CLAUDE.md` to a staging directory
   (`.archon/.archon-incoming/`).
2. Launches Claude Code with a focused prompt.
3. For every file that differs, Claude summarizes the changes and asks you
   to choose:
   - `[L]` keep your local version
   - `[N]` take the new bundled version
   - `[M]` merge manually — Claude writes a proposed merge and stops so you
     can review it in your editor
4. Cleans up the staging directory when done.

Claude is instructed to never touch `PROGRESS.md`, `USER_HINTS.md`,
`task_pending.md`, `task_done.md`, `proof-journal/`, or any `.lean` file.
Only prompts and `CLAUDE.md` are in scope.

If Claude Code is not installed (it should be, if `archon setup` succeeded),
the merge step falls back to a text-only diff summary.

### 3.4 After init completes

`archon init` will:

- Finish by running `/archon-lean4:doctor` to verify Lean, MCP, and skills
  are healthy.
- Print the next step: `archon loop /path/to/your-lean-project`.

You can now run the loop as usual.

---

## 4. Things you can safely delete

Once the new CLI is installed and your projects have been re-initialized,
the following are no longer needed and can be removed:

- Your old Archon source checkout (if you installed via `pip install .`
  from it, the package has been copied into your Python environment — the
  checkout itself is no longer referenced).
- Any shell aliases or scripts that called `archon-loop.sh`, `init.sh`, or
  `review.sh` directly.
- The `.archon/prompts/` directory content *in projects you have already
  migrated* — but leave the directory itself alone; `archon init` manages
  it. (If you're worried, just leave it; stale symlinks are cleaned up on
  the next `init`.)

Do **not** delete `<project>/.archon/PROGRESS.md`,
`<project>/.archon/USER_HINTS.md`, `<project>/.archon/task_*.md`, or
`<project>/.archon/proof-journal/` — these contain your formalization state.

---

## 5. Troubleshooting

### `archon: command not found` after install

The `install.sh` script runs `pip install .` into whichever Python
environment is active when you invoke it. If you ran it inside a venv,
`archon` is only on your PATH when that venv is active. Activate it, or
install into a more permanent location and ensure that location's `bin/`
is on your PATH.

### `Claude Code is not installed`

Run `archon setup` — it will install `uv` and Claude Code and verify your
Lean toolchain. By default it asks before running `sudo`; pass `--yes` to
accept automatically.

### Merge mode shows "Claude Code is not installed — falling back to a text-only diff summary"

Install Claude Code via `archon setup`, then re-run `archon init` and
choose **merge** again.

### `archon-lean-lsp` does not appear in `claude mcp list`

Run `archon init` again. v0.1.0 explicitly removes and re-adds the
registration so the path always points at the current install.

### The dashboard did not start

Check that Node.js and npm are installed (run `archon setup` if not), and
that at least one port in 8080–8099 is free. If neither applies, pass
`--no-dashboard` to `archon loop` and start it manually in another
terminal with `archon dashboard /path/to/your-lean-project`.

### I accidentally chose overwrite and lost my prompt edits

If you committed your project before migrating (section 3.1), please note that `.archon` is gitignored by default, so you should create a backup beforehand if you want to recover your old prompts.

### I initialized successfully but the loop complains about the stage being "init"

The interactive init step did not complete. Re-run `archon init` and make
sure to finish the Claude Code session (it will ask you to confirm initial
objectives and then write them to `PROGRESS.md`).

---

## 6. Rolling back

If the migration goes sideways and you want to return to the previous
state of a project:

```bash
cd /path/to/your-lean-project
cp -r .archon-backup/ .archon/
```

Where `.archon-backup/` is a copy of `.archon/` from before the migration. Note that by default `.archon/` is gitignored.
The MCP and plugin registrations can be refreshed by running
the old `init.sh` again from your former Archon checkout, or by
re-running `archon init` and picking **keep**.

To roll back the tool install itself:

```bash
pip uninstall archon
```

Then reinstall whichever version you were on previously.

---

## Questions or issues

Please open an issue on the
[Archon repository](https://github.com/frenzymath/Archon/issues) and
describe what you ran, what you expected, and what you saw. Include the
output of `archon doctor` if possible.
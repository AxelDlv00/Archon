"""`archon branch` and `archon checkout` — inner-git strategy branches.

The mathematician uses these to fork the formalization at any point and
carry on with a different strategy. Branches live in the inner git at
`.archon/.git/`. The outer (mathematician's) git repo is never modified.

Both commands are interactive when necessary: checkout refuses with a
clear error if the outer working tree is dirty (to protect uncommitted
mathematician work), and asks the user how to handle dirty inner state.
"""

from __future__ import annotations

from pathlib import Path

import typer

from archon import log
from archon.commands.tooling.git import Git
from archon.commands.tooling.inner_git import InnerGit, _safe_branch_name
from archon.commands.tooling.version import warn_if_mismatch


# ── helpers ───────────────────────────────────────────────────────────


def _resolve_project(project_path: str) -> tuple[Path, InnerGit]:
    resolved = Path(project_path).resolve()
    if not (resolved / ".archon").is_dir():
        log.error(f"Not an Archon project: {resolved}")
        raise typer.Exit(1)
    inner = InnerGit(resolved)
    if not inner.is_initialized():
        log.error("Inner git not initialized. Run: archon init <path>")
        raise typer.Exit(1)
    return resolved, inner


def _refuse_if_outer_dirty(project_path: Path, force_hint: str | None = None) -> None:
    """Refuse with a clear error if the outer (mathematician's) tree is dirty.

    `archon checkout` replaces files on disk — if the mathematician has
    uncommitted work, that work is at risk. Block the operation until
    they commit or stash. If the caller supports a bypass, pass
    ``force_hint`` to surface it in the error message.
    """
    outer = Git(project_path, auto_init=False)
    if not outer.is_repo():
        return
    if outer.is_dirty():
        log.error(
            "The outer git repo is dirty — there are uncommitted changes "
            "in your working tree. archon checkout rewrites files on disk."
        )
        log.step("Commit or stash your work first:")
        log.step("  git add -A && git commit -m '<message>'")
        log.step("  # or:")
        log.step("  git stash")
        if force_hint:
            log.step("")
            log.step("Or bypass this check and overwrite your uncommitted work:")
            log.step(f"  {force_hint}")
        raise typer.Exit(1)


# ── branch ────────────────────────────────────────────────────────────


def branch(
    strategy: str = typer.Argument(
        ...,
        help="Name of the strategy — used as the inner-git branch name.",
    ),
    project_path: str = typer.Argument(".", help="Path to Lean project."),
    from_ref: str = typer.Option(
        "HEAD", "--from", "-f",
        help="Inner-git ref to branch off (default: current HEAD).",
    ),
    checkout: bool = typer.Option(
        True, "--checkout/--no-checkout",
        help="Immediately switch to the new branch.",
    ),
) -> None:
    """Create a new inner-git branch named after the strategy.

    [bold]Example:[/bold]
      [cyan]archon branch bolzano-weierstrass .[/cyan]

    Creates an inner-git branch "bolzano-weierstrass" at the current HEAD
    and switches to it. The mathematician can now run `archon loop` and
    the new iterations will land on this branch.
    """
    resolved, inner = _resolve_project(project_path)
    warn_if_mismatch(resolved)

    safe = _safe_branch_name(strategy)
    if safe != strategy:
        log.info(f"Branch name normalized: {strategy!r} → {safe!r}")

    if inner.has_branch(safe):
        log.error(f"Branch already exists: {safe}")
        log.step(f"Switch to it: archon checkout {safe} {project_path}")
        raise typer.Exit(1)

    try:
        inner.create_branch(safe, from_ref=from_ref)
    except Exception as e:
        log.error(f"Failed to create branch: {e}")
        raise typer.Exit(1)

    log.success(f"Created inner-git branch: {safe}")

    if checkout:
        _refuse_if_outer_dirty(resolved)
        try:
            inner.checkout(safe)
        except Exception as e:
            log.error(f"Failed to switch to {safe}: {e}")
            raise typer.Exit(1)
        log.success(f"Switched to: {safe}")


# ── checkout ──────────────────────────────────────────────────────────


def checkout(
    ref: str = typer.Argument(
        ...,
        help="Branch name or commit SHA to switch to (in the inner git).",
    ),
    project_path: str = typer.Argument(".", help="Path to Lean project."),
    force: bool = typer.Option(
        False, "--force",
        help="Bypass the outer-dirty check AND overwrite any inner-tracked "
             "changes. Dangerous — may overwrite uncommitted work.",
    ),
    keep_untracked: bool = typer.Option(
        False, "--keep-untracked",
        help="Do not remove untracked files (e.g. iteration logs, task "
             "results) created after the target commit. By default they "
             "are removed so the working tree fully matches the target.",
    ),
) -> None:
    """Switch the inner git to a different branch or commit.

    This rewrites `.lean` / blueprint files on disk to match the target,
    AND removes iteration logs / task results that were created after the
    target commit — so the dashboard, graph, and files all reflect the
    state of the commit you asked for. Pass [cyan]--keep-untracked[/cyan]
    to preserve later artifacts.

    If your outer (mathematician's) git repo has uncommitted changes, the
    operation is refused by default — commit or stash first, or pass
    [cyan]--force[/cyan] to overwrite them.

    [bold]Examples:[/bold]
      [cyan]archon checkout main .[/cyan]
      [cyan]archon checkout bolzano-weierstrass .[/cyan]
      [cyan]archon checkout abc1234 .[/cyan]
      [cyan]archon checkout abc1234 . --force[/cyan]   (discard uncommitted outer changes)
      [cyan]archon checkout abc1234 . --keep-untracked[/cyan]   (preserve later iter-* logs)
    """
    resolved, inner = _resolve_project(project_path)
    warn_if_mismatch(resolved)

    if not force:
        _refuse_if_outer_dirty(
            resolved,
            force_hint=f"archon checkout {ref} {project_path} --force",
        )

    # Warn (but do not block) if the inner repo is dirty — the user may
    # be mid-iteration and have unfinished agent work. Dropping it would
    # be destructive, so we surface it and let the user decide.
    if inner.is_dirty() and not force:
        log.warn(
            "Inner git has uncommitted agent work. Switching branches now "
            "will carry those changes over (if they don't conflict) or "
            "refuse with a conflict error."
        )
        log.step("To commit current agent state first:")
        log.step(f"  git --git-dir={resolved}/.archon/git-dir --work-tree={resolved} commit -am 'archon: checkpoint'")
        log.step("To discard current agent state instead:")
        log.step(f"  archon clean {project_path}")
        log.step(f"Or re-run with --force to overwrite inner changes: "
                 f"archon checkout {ref} {project_path} --force")
        log.step("")
        if not typer.confirm("Continue with checkout anyway?", default=False):
            raise typer.Exit(0)

    try:
        inner.checkout(ref, force=force)
    except Exception as e:
        log.error(f"Failed to checkout {ref}: {e}")
        raise typer.Exit(1)

    log.success(f"Switched to: {ref}")
    sha = inner.head_sha(short=True)
    if sha:
        log.step(f"Inner HEAD: {sha}  ({inner.last_commit_subject() or '?'})")

    # Remove files that don't belong to the target commit — stale
    # iteration logs, task_results, and anything else created on later
    # commits. Without this the dashboard keeps showing "future" runs.
    if keep_untracked:
        leftover = inner.clean_untracked(dry_run=True)
        if leftover:
            log.info(
                f"Kept {len(leftover)} untracked path(s) from later commits "
                f"(--keep-untracked). The dashboard may still show them:"
            )
            _log_path_preview(leftover)
        return

    removed = inner.clean_untracked(dry_run=False)
    if not removed:
        return
    log.info(f"Removed {len(removed)} untracked path(s) not present at {ref}:")
    _log_path_preview(removed)


def _log_path_preview(paths: list[str], limit: int = 10) -> None:
    for p in paths[:limit]:
        log.step(f"  {p}")
    if len(paths) > limit:
        log.step(f"  ... ({len(paths) - limit} more)")


# ── log (small helper, handy for archon users) ────────────────────────


def inner_log(
    project_path: str = typer.Argument(".", help="Path to Lean project."),
    n: int = typer.Option(20, "-n", help="Number of commits to show."),
) -> None:
    """Show the inner-git commit graph (one-line format)."""
    resolved, inner = _resolve_project(project_path)
    output = inner.log_oneline(n=n)
    if not output.strip():
        log.info("Inner git has no commits yet.")
        return
    log.header(f"Inner git log (last {n})")
    typer.echo(output)

"""Start the automated plan → prove → review loop."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Optional

import typer

from archon import log
from archon.runner import (
    build_parallel_prover_prompt,
    build_plan_prompt,
    build_prover_prompt,
    build_review_prompt,
    run_claude,
)
from archon.state import (
    CostData,
    archive_task_results,
    cost_summary,
    is_complete,
    next_iter_num,
    next_session_num,
    parse_objective_files,
    read_stage,
    utcnow_iso,
    write_meta,
)
from archon.types import Stage


def _data_path(sub_path: str = "") -> Path:
    root = resources.files("archon").joinpath(".archon-src")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _relpath(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def _file_slug(rel: str) -> str:
    return rel.replace("/", "_").replace(os.sep, "_").removesuffix(".lean")


# ── preflight ─────────────────────────────────────────────────────────


def _preflight(project_path: Path, state_dir: Path, dry_run: bool) -> None:
    progress = state_dir / "PROGRESS.md"

    if not dry_run:
        if not shutil.which("claude"):
            log.error("Claude Code is not installed. Run: archon setup")
            raise typer.Exit(1)

        r = subprocess.run(
            ["claude", "-p", "reply with OK", "--no-session-persistence"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            log.error("Claude Code cannot run. Check: claude auth, ANTHROPIC_API_KEY, network.")
            raise typer.Exit(1)
        log.success("Claude Code is authenticated and ready")

    if not progress.exists():
        log.error(f"No project state found. Run: archon init {project_path}")
        raise typer.Exit(1)

    stage = read_stage(progress)
    if stage == "init":
        log.error(f"Project is still in init stage. Run: archon init {project_path}")
        raise typer.Exit(1)


def _emit_parallel_round_end(iter_dir: Path, prover_count: int, failed: int) -> None:
    """Write a parallel_round_end event to the iteration's JSONL log."""
    provers_dir = iter_dir / "provers"
    # Append to any existing prover log, or create one at iter level
    target = None
    if provers_dir.exists():
        logs = sorted(provers_dir.glob("*.jsonl"))
        if logs:
            target = logs[0]
    if target is None:
        target = iter_dir / "parallel.jsonl"

    row = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event": "parallel_round_end",
        "prover_count": prover_count,
        "failed": failed,
    }
    with target.open("a") as f:
        f.write(json.dumps(row) + "\n")


# ── parallel provers ──────────────────────────────────────────────────


def _run_single_prover(
    prompt: str,
    cwd: Path,
    log_base: Path,
    verbose_logs: bool,
) -> bool:
    """Entry point for a single prover (may run in subprocess)."""
    return run_claude(prompt, cwd=cwd, log_base=log_base, verbose_logs=verbose_logs)


def _run_parallel_provers(
    project_name: str,
    project_path: Path,
    state_dir: Path,
    stage: str,
    iter_dir: Path,
    iter_meta: Path,
    max_parallel: int,
    verbose_logs: bool,
    dry_run: bool,
) -> None:
    """Parse objective files and launch one prover per file."""
    progress = state_dir / "PROGRESS.md"

    archive_task_results(state_dir, state_dir / "logs")

    sorry_files = parse_objective_files(progress, project_path)
    if not sorry_files:
        log.warn("No files parsed from PROGRESS.md ## Current Objectives.")
        log.warn("The plan agent must list target files in **bold** or `backticks`.")
        log.warn("Skipping prover iteration.")
        return

    file_count = len(sorry_files)

    # Single file → run serial
    if file_count == 1:
        rel = _relpath(sorry_files[0], project_path)
        slug = _file_slug(rel)
        log.info(f"Only 1 file ({rel}) — running serial prover")

        prover_log = iter_dir / "provers" / slug
        write_meta(iter_meta, **{f"provers.{slug}.file": rel, f"provers.{slug}.status": "running"})

        prompt = build_prover_prompt(project_name, project_path, state_dir, stage)
        ok = run_claude(prompt, cwd=project_path, log_base=prover_log, verbose_logs=verbose_logs)
        write_meta(iter_meta, **{f"provers.{slug}.status": "done" if ok else "error"})
        return

    log.info(f"Found {file_count} file(s) — launching parallel provers (max {max_parallel} concurrent)")

    base_prompt = build_parallel_prover_prompt(project_name, project_path, state_dir, stage)

    if dry_run:
        for f in sorry_files:
            rel = _relpath(f, project_path)
            log.step(f"[dry-run] Prover: {rel}")
        return

    log.info(f"Watch progress:")
    log.step(f"tail -f {iter_dir}/provers/*.jsonl")
    log.step(f"watch -n10 'ls -lt {state_dir}/task_results/'")

    # Launch provers with ProcessPoolExecutor
    futures = {}
    with ProcessPoolExecutor(max_workers=min(max_parallel, file_count)) as pool:
        for f in sorry_files:
            rel = _relpath(f, project_path)
            slug = _file_slug(rel)
            prover_log = iter_dir / "provers" / slug
            prompt = f"{base_prompt}\nYour assigned file: {rel}"

            log.step(f"Starting prover for {rel} (log: provers/{slug}.jsonl)")
            write_meta(iter_meta, **{f"provers.{slug}.file": rel, f"provers.{slug}.status": "running"})

            future = pool.submit(
                _run_single_prover, prompt, project_path, prover_log, verbose_logs,
            )
            futures[future] = (rel, slug)

        failed = 0
        for future in as_completed(futures):
            rel, slug = futures[future]
            try:
                ok = future.result()
            except Exception:
                ok = False
            status = "done" if ok else "error"
            write_meta(iter_meta, **{f"provers.{slug}.status": status})
            if ok:
                log.info(f"  Prover for {rel} finished")
            else:
                log.warn(f"  Prover for {rel} had errors")
                failed += 1

    if failed:
        log.warn(f"{failed}/{file_count} prover(s) had errors")
    else:
        log.success(f"All {file_count} prover(s) finished successfully")

    # Report task results
    results_dir = state_dir / "task_results"
    result_count = len(list(results_dir.glob("*.md"))) if results_dir.exists() else 0
    log.info(f"Found {result_count}/{file_count} task result file(s)")

    # Emit parallel round event for dashboard consumption
    _emit_parallel_round_end(iter_dir, file_count, failed)


# ── review phase ──────────────────────────────────────────────────────


def _run_review_phase(
    project_name: str,
    project_path: Path,
    state_dir: Path,
    stage: str,
    iter_dir: Path,
    verbose_logs: bool,
) -> None:
    session_num = next_session_num(state_dir)
    journal_dir = state_dir / "proof-journal"
    session_dir = journal_dir / "sessions" / f"session_{session_num}"
    current_session_dir = journal_dir / "current_session"
    attempts_file = current_session_dir / "attempts_raw.jsonl"

    session_dir.mkdir(parents=True, exist_ok=True)
    current_session_dir.mkdir(parents=True, exist_ok=True)

    # Extract attempt data from prover logs
    log.info("Extracting attempt data from prover logs...")
    provers_dir = iter_dir / "provers"
    if provers_dir.exists() and list(provers_dir.glob("*.jsonl")):
        combined = iter_dir / "provers-combined.jsonl"
        with combined.open("w") as out:
            for jf in sorted(provers_dir.glob("*.jsonl")):
                out.write(jf.read_text())
    else:
        combined = iter_dir / "prover.jsonl"

    extract_script = _data_path("scripts/extract-attempts.py") if _data_path("scripts/extract-attempts.py").exists() else None
    if extract_script and extract_script.exists():
        subprocess.run(
            [sys.executable, str(extract_script), str(combined), str(attempts_file)],
            capture_output=True,
        )

    # Run review agent
    prompt = build_review_prompt(
        project_name, project_path, state_dir, stage,
        session_num, session_dir, attempts_file, combined,
    )
    review_log = iter_dir / "review"
    run_claude(prompt, cwd=project_path, log_base=review_log, verbose_logs=verbose_logs)

    # Validate review output
    validate_script = _data_path("scripts/validate-review.py") if _data_path("scripts/validate-review.py").exists() else None
    if validate_script and validate_script.exists():
        subprocess.run(
            [sys.executable, str(validate_script), str(session_dir), str(attempts_file)],
            capture_output=True,
        )


# ── main command ──────────────────────────────────────────────────────


def loop(
    project_path: str = typer.Argument(".", help="Path to Lean project"),
    max_iterations: int = typer.Option(
        10, "--max-iterations", "-m", help="Max plan→prover→review cycles.",
    ),
    max_parallel: int = typer.Option(
        8, "--max-parallel", help="Max concurrent provers in parallel mode.",
    ),
    stage: Optional[Stage] = typer.Option(
        None, "--stage", "-s",
        help="Force a stage instead of reading from PROGRESS.md.",
    ),
    parallel: bool = typer.Option(
        True, "--parallel/--serial",
        help="Run provers in parallel (one per file) or serially.",
    ),
    verbose_logs: bool = typer.Option(
        False, "--verbose-logs",
        help="Save raw Claude stream events to .raw.jsonl.",
    ),
    no_review: bool = typer.Option(
        False, "--no-review",
        help="Skip review phase after each iteration.",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="Print prompts without launching Claude.",
    ),
) -> None:
    """Start the automated plan → prove → review loop.

    Alternates plan and prover agents through stages (autoformalize → prover
    → polish) until COMPLETE or max iterations reached.
    """
    resolved = Path(project_path).resolve()
    project_name = resolved.name
    state_dir = resolved / ".archon"
    progress_file = state_dir / "PROGRESS.md"
    log_dir = state_dir / "logs"
    force_stage = stage.value if stage else None

    _preflight(resolved, state_dir, dry_run)

    if not dry_run:
        log_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "task_results").mkdir(exist_ok=True)
        (state_dir / "proof-journal" / "sessions").mkdir(parents=True, exist_ok=True)
        (state_dir / "proof-journal" / "current_session").mkdir(parents=True, exist_ok=True)

    current_stage = read_stage(progress_file, force_stage)

    prover_mode = "parallel" if parallel else "serial"
    if parallel:
        prover_mode += f" (max {max_parallel})"

    config = {
        "Project": str(resolved),
        "Stage": force_stage or current_stage,
        "Max iterations": str(max_iterations),
        "Prover mode": prover_mode,
        "Review": "enabled" if not no_review else "disabled",
        "Logs": str(log_dir),
        "User hints": str(state_dir / "USER_HINTS.md"),
    }
    if dry_run:
        config["Mode"] = "[yellow]DRY RUN[/yellow]"

    log.header("Archon Loop")
    log.key_value(config)

    if is_complete(progress_file, force_stage):
        log.success(f"Project '{project_name}' is COMPLETE. Nothing to do.")
        return

    loop_start = time.monotonic()

    for i in range(max_iterations):
        current_stage = read_stage(progress_file, force_stage)

        if is_complete(progress_file, force_stage):
            log.success("PROGRESS.md says COMPLETE. Exiting loop.")
            break

        log.iteration(i + 1, max_iterations, current_stage, project_name)

        iter_start = time.monotonic()

        # Set up iteration directory
        iter_dir: Path | None = None
        iter_meta: Path | None = None
        if not dry_run:
            iter_num = next_iter_num(log_dir)
            iter_dir = log_dir / f"iter-{iter_num:03d}"
            iter_meta = iter_dir / "meta.json"
            iter_dir.mkdir(parents=True, exist_ok=True)
            if parallel:
                (iter_dir / "provers").mkdir(exist_ok=True)
            write_meta(
                iter_meta,
                iteration=iter_num,
                stage=current_stage,
                mode="parallel" if parallel else "serial",
                startedAt=utcnow_iso(),
            )
            write_meta(iter_meta, **{"plan.status": "running"})
            log.info(f"Log dir: {iter_dir}")

        # ── Phase 1: Plan ──
        log.phase(1, "Plan agent")

        plan_start = time.monotonic()
        plan_prompt = build_plan_prompt(project_name, resolved, state_dir, current_stage)

        if dry_run:
            log.step("[dry-run] Plan prompt:")
            print(plan_prompt)
        else:
            plan_log = iter_dir / "plan"
            run_claude(plan_prompt, cwd=resolved, log_base=plan_log, verbose_logs=verbose_logs)

        plan_secs = int(time.monotonic() - plan_start)
        log.info(f"Plan phase finished. ({plan_secs}s)")
        if not dry_run:
            write_meta(iter_meta, **{"plan.status": "done", "plan.durationSecs": plan_secs})

        if is_complete(progress_file, force_stage):
            log.success("PROGRESS.md says COMPLETE. Exiting loop.")
            break

        current_stage = read_stage(progress_file, force_stage)

        # ── Phase 2: Prover ──
        log.phase(2, f"Prover agent(s) — {'parallel' if parallel else 'serial'}")

        prover_start = time.monotonic()
        if not dry_run:
            write_meta(iter_meta, **{"prover.status": "running"})

        if parallel:
            _run_parallel_provers(
                project_name, resolved, state_dir, current_stage,
                iter_dir, iter_meta, max_parallel, verbose_logs, dry_run,
            )
        else:
            prover_prompt = build_prover_prompt(project_name, resolved, state_dir, current_stage)
            if dry_run:
                log.step("[dry-run] Prover prompt:")
                print(prover_prompt)
            else:
                prover_log = iter_dir / "prover"
                run_claude(prover_prompt, cwd=resolved, log_base=prover_log, verbose_logs=verbose_logs)

        prover_secs = int(time.monotonic() - prover_start)
        log.info(f"Prover phase finished. ({prover_secs}s)")
        if not dry_run:
            write_meta(iter_meta, **{"prover.status": "done", "prover.durationSecs": prover_secs})

        # ── Phase 3: Review ──
        if not no_review and not dry_run:
            log.phase(3, "Review agent")

            review_start = time.monotonic()
            write_meta(iter_meta, **{"review.status": "running"})

            _run_review_phase(
                project_name, resolved, state_dir, current_stage,
                iter_dir, verbose_logs,
            )

            review_secs = int(time.monotonic() - review_start)
            log.info(f"Review phase finished. ({review_secs}s)")
            write_meta(iter_meta, **{"review.status": "done", "review.durationSecs": review_secs})

        iter_secs = int(time.monotonic() - iter_start)
        log.info(f"Iteration {i + 1} complete. Wall time: {iter_secs}s")
        if not dry_run:
            write_meta(iter_meta, completedAt=utcnow_iso(), wallTimeSecs=iter_secs)
            data = cost_summary(iter_dir)
            if data:
                log.cost_table(
                    f"Iteration {i + 1}",
                    data.totals_dict(),
                    data.model_rows() or None,
                )

    loop_secs = int(time.monotonic() - loop_start)
    if not is_complete(progress_file, force_stage):
        log.warn(f"Reached max iterations ({max_iterations}). Stopping.")
    log.info(f"Total wall time: {loop_secs}s")
    data = cost_summary(log_dir)
    if data:
        log.cost_table("Loop totals", data.totals_dict(), data.model_rows() or None)
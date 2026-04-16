"""Start the automated plan → prove → review loop."""

from __future__ import annotations

import atexit
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
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


# ── dashboard auto-launch ─────────────────────────────────────────────


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


def _find_free_port(start: int = 8080, attempts: int = 20) -> int | None:
    for p in range(start, start + attempts):
        if _port_free(p):
            return p
    return None


def _start_dashboard(project_path: Path, open_browser: bool) -> tuple[subprocess.Popen | None, int | None]:
    """Start the dashboard UI as a background process.

    Returns (process, port) or (None, None) on failure. Registers an atexit
    hook so the process is cleaned up when `archon loop` exits.
    """
    if not shutil.which("node") or not shutil.which("npm"):
        log.warn("Dashboard skipped: Node.js / npm not found (run: archon setup)")
        return None, None

    port = _find_free_port(8080)
    if port is None:
        log.warn("Dashboard skipped: could not find a free port in 8080–8099")
        return None, None

    # Delegate to `archon dashboard` so all the build/install logic lives in one place.
    # --build-free path: dashboard command handles build if needed.
    cmd = ["archon", "dashboard", str(project_path), "--port", str(port)]

    # Detach from terminal I/O so streaming prover logs stay clean
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # so Ctrl-C in loop doesn't hit the dashboard
        )
    except Exception as e:
        log.warn(f"Dashboard failed to start: {e}")
        return None, None

    # Give it a moment to bind
    for _ in range(10):
        time.sleep(0.5)
        if not _port_free(port):
            break
        if proc.poll() is not None:
            log.warn("Dashboard process exited before binding its port")
            return None, None

    url = f"http://localhost:{port}"
    log.panel(
        f"Dashboard is live at [bold cyan]{url}[/bold cyan]\n"
        f"Watch iterations, parallel provers, diffs, and the proof journal update live.",
        title="Archon Dashboard",
        style="cyan",
    )

    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    def _cleanup():
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except Exception:
                try:
                    proc.terminate()
                except Exception:
                    pass
    atexit.register(_cleanup)

    return proc, port


# ── snapshot helpers ──────────────────────────────────────────────────


def _snapshot_baseline(file_path: Path, snap_dir: Path) -> None:
    """Copy a .lean file as baseline.lean into the given snapshot directory."""
    snap_dir.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(file_path, snap_dir / "baseline.lean")
    except OSError:
        pass


def _set_prover_env(
    snap_dir: Path | str,
    prover_jsonl: Path | str,
    project_path: Path | str,
    serial_mode: bool = False,
) -> dict[str, str]:
    old = {}
    env_vars = {
        "ARCHON_SNAPSHOT_DIR": str(snap_dir),
        "ARCHON_PROVER_JSONL": str(prover_jsonl),
        "ARCHON_PROJECT_PATH": str(project_path),
    }
    if serial_mode:
        env_vars["ARCHON_SERIAL_MODE"] = "true"

    for k, v in env_vars.items():
        old[k] = os.environ.get(k)
        os.environ[k] = v
    return old


def _unset_prover_env(old: dict[str, str]) -> None:
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


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
    provers_dir = iter_dir / "provers"
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


# ── parallel provers (unchanged from previous version) ────────────────


def _run_single_prover(
    prompt: str,
    cwd: Path,
    log_base: Path,
    verbose_logs: bool,
    snap_dir: Path | None = None,
    project_path: Path | None = None,
) -> bool:
    if snap_dir is not None and project_path is not None:
        old_env = _set_prover_env(
            snap_dir=snap_dir,
            prover_jsonl=Path(str(log_base) + ".jsonl"),
            project_path=project_path,
        )
    else:
        old_env = None

    try:
        return run_claude(prompt, cwd=cwd, log_base=log_base, verbose_logs=verbose_logs)
    finally:
        if old_env is not None:
            _unset_prover_env(old_env)


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
    dashboard_url: str | None = None,
) -> None:
    progress = state_dir / "PROGRESS.md"

    archive_task_results(state_dir, state_dir / "logs")

    sorry_files = parse_objective_files(progress, project_path)
    if not sorry_files:
        log.warn("No files parsed from PROGRESS.md ## Current Objectives.")
        log.warn("The plan agent must list target files in **bold** or `backticks`.")
        log.warn("Skipping prover iteration.")
        return

    file_count = len(sorry_files)

    if dry_run:
        for f in sorry_files:
            rel = _relpath(f, project_path)
            log.step(f"[dry-run] Prover: {rel}")
        return

    if file_count == 1:
        rel = _relpath(sorry_files[0], project_path)
        slug = _file_slug(rel)
        log.info(f"Only 1 file ({rel}) — running serial prover")

        prover_log = iter_dir / "provers" / slug
        write_meta(iter_meta, **{f"provers.{slug}.file": rel, f"provers.{slug}.status": "running"})

        snap_dir = iter_dir / "snapshots" / slug
        _snapshot_baseline(sorry_files[0], snap_dir)

        old_env = _set_prover_env(
            snap_dir=snap_dir,
            prover_jsonl=Path(str(prover_log) + ".jsonl"),
            project_path=project_path,
        )
        try:
            prompt = build_prover_prompt(project_name, project_path, state_dir, stage)
            ok = run_claude(prompt, cwd=project_path, log_base=prover_log, verbose_logs=verbose_logs)
        finally:
            _unset_prover_env(old_env)

        write_meta(iter_meta, **{f"provers.{slug}.status": "done" if ok else "error"})
        return

    log.info(f"Found {file_count} file(s) — launching parallel provers (max {max_parallel} concurrent)")

    base_prompt = build_parallel_prover_prompt(project_name, project_path, state_dir, stage)

    log.info("Watch progress:")
    if dashboard_url:
        log.step(f"Dashboard:       {dashboard_url}")
        log.step(f"Iteration view:  {dashboard_url}/logs")
    log.step(f"tail -f {iter_dir}/provers/*.jsonl")
    log.step(f"watch -n10 'ls -lt {state_dir}/task_results/'")

    futures = {}
    with ProcessPoolExecutor(max_workers=min(max_parallel, file_count)) as pool:
        for f in sorry_files:
            rel = _relpath(f, project_path)
            slug = _file_slug(rel)
            prover_log = iter_dir / "provers" / slug
            prompt = f"{base_prompt}\nYour assigned file: {rel}"

            snap_dir = iter_dir / "snapshots" / slug
            _snapshot_baseline(f, snap_dir)

            log.step(f"Starting prover for {rel} (log: provers/{slug}.jsonl)")
            write_meta(iter_meta, **{f"provers.{slug}.file": rel, f"provers.{slug}.status": "running"})

            future = pool.submit(
                _run_single_prover,
                prompt,
                project_path,
                prover_log,
                verbose_logs,
                snap_dir,
                project_path,
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

    results_dir = state_dir / "task_results"
    result_count = len(list(results_dir.glob("*.md"))) if results_dir.exists() else 0
    log.info(f"Found {result_count}/{file_count} task result file(s)")

    _emit_parallel_round_end(iter_dir, file_count, failed)


# ── review phase (unchanged) ──────────────────────────────────────────


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

    log.info("Extracting attempt data from prover logs...")
    provers_dir = iter_dir / "provers"
    if provers_dir.exists() and list(provers_dir.glob("*.jsonl")):
        combined = iter_dir / "provers-combined.jsonl"
        with combined.open("w") as out:
            for jf in sorted(provers_dir.glob("*.jsonl")):
                out.write(jf.read_text())
    else:
        combined = iter_dir / "prover.jsonl"

    extract_script = _data_path("scripts/extract-attempts.py")
    if extract_script.exists():
        subprocess.run(
            [sys.executable, str(extract_script), str(combined), str(attempts_file)],
            capture_output=True,
        )

    prompt = build_review_prompt(
        project_name, project_path, state_dir, stage,
        session_num, session_dir, attempts_file, combined,
    )
    review_log = iter_dir / "review"
    run_claude(prompt, cwd=project_path, log_base=review_log, verbose_logs=verbose_logs)

    validate_script = _data_path("scripts/validate-review.py")
    if validate_script.exists():
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
    no_dashboard: bool = typer.Option(
        False, "--no-dashboard",
        help="Do not auto-start the web dashboard.",
    ),
    open_browser: bool = typer.Option(
        False, "--open",
        help="Open the dashboard in a browser as soon as it starts.",
    ),
) -> None:
    """Start the automated plan → prove → review loop.

    By default, the web dashboard is launched in the background so you can
    watch iterations live. Pass --no-dashboard to disable this.
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
        "Dashboard": "disabled" if no_dashboard else "enabled",
        "Logs": str(log_dir),
        "User hints": str(state_dir / "USER_HINTS.md"),
    }
    if dry_run:
        config["Mode"] = "[yellow]DRY RUN[/yellow]"

    log.header("Archon Loop")
    log.key_value(config)

    # ── Start dashboard ──────────────────────────────────────────────
    dashboard_proc: subprocess.Popen | None = None
    dashboard_url: str | None = None
    if not dry_run and not no_dashboard:
        dashboard_proc, dashboard_port = _start_dashboard(resolved, open_browser)
        if dashboard_port:
            dashboard_url = f"http://localhost:{dashboard_port}"

    if is_complete(progress_file, force_stage):
        log.success(f"Project '{project_name}' is COMPLETE. Nothing to do.")
        if dashboard_url:
            log.step(f"Review results in the dashboard: {dashboard_url}")
        return

    loop_start = time.monotonic()

    for i in range(max_iterations):
        current_stage = read_stage(progress_file, force_stage)

        if is_complete(progress_file, force_stage):
            log.success("PROGRESS.md says COMPLETE. Exiting loop.")
            break

        log.iteration(i + 1, max_iterations, current_stage, project_name)
        if dashboard_url:
            log.step(f"Live view: {dashboard_url}")

        iter_start = time.monotonic()

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
                dashboard_url=dashboard_url,
            )
        else:
            prover_prompt = build_prover_prompt(project_name, resolved, state_dir, current_stage)
            if dry_run:
                log.step("[dry-run] Prover prompt:")
                print(prover_prompt)
            else:
                prover_log = iter_dir / "prover"
                sorry_files = parse_objective_files(progress_file, resolved)
                if sorry_files:
                    for sf in sorry_files:
                        srel = _relpath(sf, resolved)
                        sslug = _file_slug(srel)
                        ssnap = iter_dir / "snapshots" / sslug
                        _snapshot_baseline(sf, ssnap)

                old_env = _set_prover_env(
                    snap_dir=iter_dir / "snapshots",
                    prover_jsonl=Path(str(prover_log) + ".jsonl"),
                    project_path=resolved,
                    serial_mode=True,
                )
                try:
                    run_claude(prover_prompt, cwd=resolved, log_base=prover_log, verbose_logs=verbose_logs)
                finally:
                    _unset_prover_env(old_env)

        prover_secs = int(time.monotonic() - prover_start)
        log.info(f"Prover phase finished. ({prover_secs}s)")
        if dashboard_url:
            log.step(f"Inspect diffs: {dashboard_url}/diffs")
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
            if dashboard_url:
                log.step(f"Journal:       {dashboard_url}/journal")
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

    if dashboard_url:
        log.panel(
            f"Loop finished. The dashboard is still running at [bold cyan]{dashboard_url}[/bold cyan].\n"
            f"Inspect results, then stop it with Ctrl-C or by closing this terminal.",
            title="Done",
            style="green",
        )
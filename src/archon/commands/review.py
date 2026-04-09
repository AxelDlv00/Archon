"""Standalone review of a prover session."""

from __future__ import annotations

import subprocess
import sys
from importlib import resources
from pathlib import Path
from typing import Optional

import typer

from archon import log
from archon.runner import build_review_prompt, run_claude
from archon.state import next_session_num, read_stage


def _data_path(sub_path: str = "") -> Path:
    root = resources.files("archon").joinpath(".archon-src")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _find_latest_prover_log(state_dir: Path) -> Path | None:
    """Find the latest prover log, checking iter-NNN/ dirs then legacy flat layout."""
    log_dir = state_dir / "logs"
    if not log_dir.exists():
        return None

    # Structured layout: iter-NNN/
    iter_dirs = sorted(log_dir.glob("iter-*"))
    if iter_dirs:
        latest = iter_dirs[-1]
        # Prefer provers-combined.jsonl, then individual prover logs, then prover.jsonl
        combined = latest / "provers-combined.jsonl"
        if combined.exists() and combined.stat().st_size > 0:
            return combined

        # Try to build combined from provers/ directory
        provers_dir = latest / "provers"
        if provers_dir.exists():
            jsonl_files = sorted(provers_dir.glob("*.jsonl"))
            if jsonl_files:
                combined.parent.mkdir(parents=True, exist_ok=True)
                with combined.open("w") as out:
                    for jf in jsonl_files:
                        out.write(jf.read_text())
                if combined.stat().st_size > 0:
                    return combined

        prover = latest / "prover.jsonl"
        if prover.exists():
            return prover

    # Legacy flat layout: archon-*.jsonl
    legacy = sorted(log_dir.glob("archon-*.jsonl"))
    if legacy:
        return legacy[-1]

    return None


def review(
    project_path: str = typer.Argument(".", help="Path to Lean project"),
    log_file: Optional[str] = typer.Option(
        None, "--log",
        help="Review a specific .jsonl log file (default: latest in .archon/logs/).",
    ),
) -> None:
    """Run the review agent on a project.

    Runs the review pipeline independently of the main loop:
      1. Extracts structured attempt data from the prover log
      2. Launches the review agent to produce proof journal
      3. Validates review output quality

    Output goes to <project>/.archon/proof-journal/sessions/.
    """
    resolved = Path(project_path).resolve()
    project_name = resolved.name
    state_dir = resolved / ".archon"
    progress_file = state_dir / "PROGRESS.md"

    # Pre-flight
    if not state_dir.is_dir():
        log.error(f"No .archon/ found in {resolved}")
        log.error(f"Run: archon init {resolved}")
        raise typer.Exit(1)

    # Find log file
    if log_file:
        prover_log = Path(log_file).resolve()
        if not prover_log.exists():
            log.error(f"Log file not found: {prover_log}")
            raise typer.Exit(1)
    else:
        prover_log = _find_latest_prover_log(state_dir)
        if prover_log is None:
            log.error(f"No log files found in {state_dir / 'logs'}/")
            log.error("Run: archon loop first to generate prover logs.")
            raise typer.Exit(1)
        log.info(f"Using latest log: {prover_log}")

    # Session setup
    journal_dir = state_dir / "proof-journal"
    current_session_dir = journal_dir / "current_session"
    session_num = next_session_num(state_dir)
    session_dir = journal_dir / "sessions" / f"session_{session_num}"
    attempts_file = current_session_dir / "attempts_raw.jsonl"

    session_dir.mkdir(parents=True, exist_ok=True)
    current_session_dir.mkdir(parents=True, exist_ok=True)

    # Read stage
    try:
        stage = read_stage(progress_file)
    except (FileNotFoundError, ValueError):
        stage = "unknown"

    log.header(f"Review — Session {session_num}")
    log.key_value({
        "Project": str(resolved),
        "Log": str(prover_log),
        "Output": str(session_dir),
    })

    # Step 1: Extract attempt data
    log.phase(1, "Extracting attempt data")

    extract_script = _data_path("scripts/extract-attempts.py")
    if extract_script.exists():
        r = subprocess.run(
            [sys.executable, str(extract_script), str(prover_log), str(attempts_file)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            log.error(f"Failed to extract attempt data: {r.stderr.strip()}")
            raise typer.Exit(1)
        log.success("Attempt data extracted")
    else:
        log.warn("extract-attempts.py not found in package data — skipping extraction")

    # Step 2: Run review agent
    log.phase(2, "Running review agent")

    prompt = build_review_prompt(
        project_name, resolved, state_dir, stage,
        session_num, session_dir, attempts_file, prover_log,
    )

    review_log_base = state_dir / "logs" / "review-standalone"
    run_claude(prompt, cwd=resolved, log_base=review_log_base)
    log.success("Review agent finished")

    # Step 3: Validate output
    log.phase(3, "Validating review output")

    validate_script = _data_path("scripts/validate-review.py")
    if validate_script.exists():
        r = subprocess.run(
            [sys.executable, str(validate_script), str(session_dir), str(attempts_file)],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            log.success("Review passed validation")
        elif r.returncode == 1:
            log.warn("Review passed with warnings")
        else:
            log.warn("Review has validation failures — check output")
        if r.stdout.strip():
            log.step(r.stdout.strip())
    else:
        log.warn("validate-review.py not found in package data — skipping validation")

    # Summary
    log.header(f"Session {session_num} Complete")
    files = sorted(session_dir.iterdir()) if session_dir.exists() else []
    if files:
        rows = [(f.name, "ok", f"{f.stat().st_size:,} bytes") for f in files if f.is_file()]
        log.results_table(rows, title="Output Files")
    else:
        log.warn("No output files were generated")
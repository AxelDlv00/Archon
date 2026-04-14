import subprocess
import re
from datetime import datetime
from pathlib import Path
from typing import Optional
import typer

from archon import log
from archon.types import Stage 

def prove(
    statement: str = typer.Argument(
        ..., 
        help="The mathematical statement you want to prove (e.g., 'For all x, y in R, (x+y)^2 = ...')"
    ),
    project_path: str = typer.Argument(
        None,
        help="Path where you want to create the proof workspace. Otherwise, a new directory named `proof_<slug>_<timestamp>` will be created in the current directory.",
    ),
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
    """
    Launch a proof loop for a given statement.
    """
    log.header("archon prove")

    if not project_path:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        clean_words = re.sub(r'[^a-zA-Z0-9\s]', '', statement).split()[:5]
        slug = "_".join(clean_words).lower()
        dir_name = f"proof_{slug}_{timestamp}"
        project_path = Path.cwd() / dir_name
        project_path.mkdir(parents=True, exist_ok=True)
    else: 
        project_path = Path(project_path).resolve()
    
    if project_path.exists() and any(project_path.iterdir()):
        log.error(f"Provided path {project_path} is not empty. Please provide an empty or non-existent directory.")
        raise typer.Exit(1)

    project_path.mkdir(parents=True, exist_ok=True)
    statement_file = project_path / "statement.md"
    statement_file.write_text(statement, encoding="utf-8")
    log.success(f"Created workspace at {project_path}")
    log.step(f"Saved statement to statement.md")

    log.phase(1, "Running archon init")
    try:
        subprocess.run(["archon", "init", str(project_path)], check=True)
    except subprocess.CalledProcessError:
        log.error("Failed during archon init. Aborting.")
        raise typer.Exit(1)

    log.phase(2, "Starting archon loop")
    
    loop_cmd = ["archon", "loop", str(project_path)]
    loop_cmd.extend(["--max-iterations", str(max_iterations)])
    loop_cmd.extend(["--max-parallel", str(max_parallel)])
    
    if stage:
        loop_cmd.extend(["--stage", stage.value])
    if not parallel:
        loop_cmd.append("--serial")
    if verbose_logs:
        loop_cmd.append("--verbose-logs")
    if no_review:
        loop_cmd.append("--no-review")
    if dry_run:
        loop_cmd.append("--dry-run")

    try:
        subprocess.run(loop_cmd, check=True)
    except subprocess.CalledProcessError:
        log.error("Failed during archon loop.")
        raise typer.Exit(1)
        
    log.success(f"Proof process finished for: {dir_name}")
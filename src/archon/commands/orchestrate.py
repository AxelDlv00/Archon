"""Launch Archon in orchestrator-scheduled mode."""

from __future__ import annotations

import shutil
import subprocess
from importlib import resources
from pathlib import Path
from typing import Optional

import typer

from archon import log


def _has(binary: str) -> bool:
    return shutil.which(binary) is not None


def _data_path(sub_path: str = "") -> Path:
    root = resources.files("archon").joinpath(".archon-src")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _parse_stage(progress_md: Path) -> str:
    """Extract the current stage from PROGRESS.md."""
    if not progress_md.exists():
        return "unknown"
    lines = progress_md.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("## Current Stage"):
            if i + 1 < len(lines):
                return lines[i + 1].strip()
    return "unknown"


def orchestrate(
    project_path: str = typer.Argument(".", help="Path to Lean project"),
    orchestrator: str = typer.Option(
        "claude",
        "--orchestrator", "-o",
        help="Orchestrator command (e.g. 'claude', 'openclaw', or a custom script).",
    ),
    model: Optional[str] = typer.Option(
        None,
        "--model", "-m",
        help="Model for the orchestrator (default: orchestrator's default).",
    ),
    max_iterations: int = typer.Option(
        20,
        "--max-iterations",
        help="Suggested max iterations (passed to orchestrator as context).",
    ),
    resume: bool = typer.Option(
        False,
        "--resume",
        help="Resume a previous orchestrator session.",
    ),
) -> None:
    """Launch Archon in orchestrator-scheduled mode.

    Instead of the fixed plan→prover→review loop, an orchestrator drives
    Claude Code with adaptive scheduling — deciding when to plan, prove,
    or review based on the current project state.

    The orchestrator reads ORCHESTRATOR_GUIDE.md and the project's state
    files, then composes and executes `claude -p` calls as needed.

    By default, uses Claude Code itself as the orchestrator. You can
    specify a different orchestrator (like OpenClaw) with --orchestrator.
    """
    resolved = Path(project_path).resolve()
    project_name = resolved.name
    state_dir = resolved / ".archon"
    progress_file = state_dir / "PROGRESS.md"

    # ── validate project ──────────────────────────────────────────────

    if not state_dir.is_dir():
        log.error(f"No .archon/ found in {resolved}")
        log.step(f"Run: archon init {resolved}")
        raise typer.Exit(1)

    if not progress_file.exists():
        log.error("No PROGRESS.md found")
        log.step(f"Run: archon init {resolved}")
        raise typer.Exit(1)

    # ── check stage ───────────────────────────────────────────────────

    stage = _parse_stage(progress_file)

    if stage == "init":
        log.error("Project is still in 'init' stage")
        log.step("The orchestrator requires a fully initialized project.")
        log.step(f"Run: archon init {resolved}")
        log.step("Complete the interactive setup, then re-run: archon orchestrate")
        raise typer.Exit(1)

    if stage == "COMPLETE":
        log.success(f"Project '{project_name}' is already COMPLETE — nothing to do")
        return

    # ── locate guide ──────────────────────────────────────────────────

    guide_path = _data_path("../ORCHESTRATOR_GUIDE.md")
    if not guide_path.exists():
        for candidate in (
            resolved.parent / "ORCHESTRATOR_GUIDE.md",
            resolved / "ORCHESTRATOR_GUIDE.md",
            _data_path("ORCHESTRATOR_GUIDE.md"),
        ):
            if candidate.exists():
                guide_path = candidate
                break

    # ── check orchestrator available ──────────────────────────────────

    orch_binary = orchestrator.split()[0]
    if not _has(orch_binary):
        log.error(f"Orchestrator '{orch_binary}' not found in PATH")
        if orch_binary == "openclaw":
            log.step("Install OpenClaw: curl -fsSL https://openclaw.ai/install.sh | bash")
            log.step("Or use: --orchestrator claude")
        raise typer.Exit(1)

    log.header("Orchestrator Mode")
    log.key_value({
        "Project": str(resolved),
        "Stage": stage,
        "Orchestrator": orchestrator,
        "Model": model or "(default)",
        "Max iterations": str(max_iterations),
        "Guide": str(guide_path) if guide_path.exists() else "not found",
        "Resume": str(resume),
    })

    # ── build the orchestrator prompt ─────────────────────────────────

    guide_content = ""
    if guide_path.exists():
        guide_content = guide_path.read_text()

    readme_path = state_dir / "CLAUDE.md"
    readme_content = ""
    if readme_path.exists():
        readme_content = readme_path.read_text()

    progress_content = progress_file.read_text()

    prompt = f"""\
You are an orchestrator driving the Archon formalization system for project '{project_name}'.
Project directory: {resolved}
Project state directory: {state_dir}

Your job is to adaptively schedule plan, prover, and review stages to maximize
formalization progress. You are NOT a fixed loop — you read state, decide what
to run next, and invoke `claude -p` with composed prompts.

IMPORTANT: This project has already been initialized (stage: {stage}).
Do NOT ask the user any questions. Do NOT wait for user input.
You must act autonomously — read the state files and execute the appropriate
stage immediately.

## Key rules
- Always `cd {resolved}` before invoking `claude -p`
- Read .archon/PROGRESS.md after each stage to decide the next step
- Compose prompts by reading .archon/prompts/*.md and prepending context
- Inject strategic hints directly into prompts when provers are stuck
- Do NOT write to USER_HINTS.md (reserved for human user)
- Do NOT ask questions or wait for user input — act autonomously
- Run review after prover to update proof journal and PROJECT_STATUS.md
- Maximum {max_iterations} total claude -p invocations
- Stop when PROGRESS.md stage is COMPLETE

## Project context
{readme_content[:2000] if readme_content else "(Read .archon/CLAUDE.md for project context)"}

## Current state
{progress_content[:2000]}

## Full orchestrator guide
{guide_content if guide_content else "(ORCHESTRATOR_GUIDE.md not found — read README.md for guidance)"}
"""

    # ── build command ─────────────────────────────────────────────────

    cmd: list[str] = []

    if orchestrator == "claude":
        cmd = [
            "claude", "-p", prompt,
            "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions",
        ]
        if model:
            cmd.extend(["--model", model])
        if resume:
            cmd.append("--resume")
    elif orchestrator == "openclaw":
        cmd = ["openclaw", "run", "--project", str(resolved)]
        if model:
            cmd.extend(["--model", model])
        if max_iterations:
            cmd.extend(["--max-iterations", str(max_iterations)])
    else:
        cmd = orchestrator.split()
        cmd.extend([str(resolved)])

    log.info(f"Launching orchestrator: {cmd[0]}")
    log.step("The orchestrator will adaptively schedule plan/prover/review stages")
    log.step(f"Monitor progress: {state_dir}/PROGRESS.md")
    log.step(f"Proof journal: {state_dir}/proof-journal/")

    # ── run ───────────────────────────────────────────────────────────

    try:
        if orchestrator in ("claude", "openclaw"):
            result = subprocess.run(cmd, cwd=resolved)
        else:
            result = subprocess.run(
                cmd, cwd=resolved,
                input=prompt, text=True,
            )

        if result.returncode == 0:
            log.success("Orchestrator finished")
        else:
            log.warn(f"Orchestrator exited with code {result.returncode}")

    except KeyboardInterrupt:
        log.warn("Orchestrator interrupted by user")

    # ── report final state ────────────────────────────────────────────

    final_stage = _parse_stage(progress_file)
    if final_stage == "COMPLETE":
        log.success(f"Project '{project_name}' is COMPLETE!")
    elif final_stage != stage:
        log.info(f"Stage advanced: {stage} → {final_stage}")
    else:
        log.warn(f"Stage unchanged: {final_stage}")
        log.step("The orchestrator may not have made progress — check logs")
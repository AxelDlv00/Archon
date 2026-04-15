"""Initialize a new Archon project."""

import json
import shutil
import subprocess
import textwrap
from importlib import resources
from pathlib import Path

import typer

from archon import log


# ── helpers ───────────────────────────────────────────────────────────


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def _has(binary: str) -> bool:
    return shutil.which(binary) is not None


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _parse_stage(progress_md: Path) -> str:
    """Extract the current stage from PROGRESS.md."""
    if not progress_md.exists():
        return "init"
    lines = progress_md.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("## Current Stage"):
            if i + 1 < len(lines):
                return lines[i + 1].strip()
    return "init"


def _data_path(sub_path: str = "") -> Path:
    """Resolve a path inside the bundled archon/.archon-src/."""
    root = resources.files("archon").joinpath(".archon-src")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _copy_file(src: Path, dst: Path, overwrite: bool = False) -> None:
    """Copy a single file, warning if dst is being overwritten."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and overwrite:
        log.warn(f"Overwriting existing file: {dst.name}")
    
    if overwrite or not dst.exists():
        shutil.copy2(src, dst)


def _find_global_mcp_lean_lsp() -> list[str]:
    settings = Path.home() / ".claude" / "settings.json"
    data = _read_json(settings)
    return [
        k for k in data.get("mcpServers", {})
        if "lean" in k.lower() and "lsp" in k.lower() and "archon" not in k.lower()
    ]


def _find_global_lean4_plugins() -> list[str]:
    settings = Path.home() / ".claude" / "settings.json"
    data = _read_json(settings)
    return [
        k for k in data.get("enabledPlugins", {})
        if ("lean4" in k.lower() or "lean4-skills" in k.lower()) and "archon" not in k.lower()
    ]


def _update_gitignore(project_path: Path, entry: str) -> None:
    """Add entry to .gitignore if this is a git repo."""
    if not (project_path / ".git").is_dir():
        return
    gitignore = project_path / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(f"{entry}\n", encoding="utf-8")
        log.success(f"Created .gitignore with {entry}")
        return
    lines = gitignore.read_text(encoding="utf-8").splitlines()
    if entry not in [line.strip() for line in lines]:
        with gitignore.open("a", encoding="utf-8") as f:
            f.write(f"\n# Archon state directory\n{entry}\n")
        log.success(f"Added {entry} to .gitignore")


# ── steps ─────────────────────────────────────────────────────────────


def _step1_state_dir(project_path: Path, state_dir: Path, overwrite: bool = True) -> None:
    """Create .archon/ state directory and populate with template files."""
    log.phase(1, "Setting up .archon/ state directory")

    for subdir in (
        "task_results",
        "logs",
        "prompts",
        "proof-journal/sessions",
        "proof-journal/current_session",
    ):
        (state_dir / subdir).mkdir(parents=True, exist_ok=True)
    log.step("Created directory tree")

    template_dir = _data_path("archon-template")
    copied = 0
    for name, ovrw in (
        ("PROGRESS.md", False),
        ("CLAUDE.md", overwrite),
        ("USER_HINTS.md", False),
        ("task_pending.md", False),
        ("task_done.md", False),
        ("REFACTOR_DIRECTIVE.md", False),
    ):
        src = template_dir / name
        if src.exists():
            _copy_file(src, state_dir / name, overwrite=ovrw)
            copied += 1
        else:
            log.warn(f"Template not found: {name}")
    log.step(f"Copied {copied} template file(s)")

    _update_gitignore(project_path, ".archon/")
    log.success("State directory ready")


def _step2_copy_prompts(state_dir: Path, overwrite: bool =True) -> None:
    """Copy prompt files into .archon/prompts/."""
    log.phase(2, "Copying prompts")

    prompts_src = _data_path("prompts")
    prompts_dst = state_dir / "prompts"
    prompts_dst.mkdir(parents=True, exist_ok=True)

    if not prompts_src.exists():
        log.error(f"Prompts directory not found at {prompts_src}")
        return

    count = 0
    for f in sorted(prompts_src.glob("*.md")):
        _copy_file(f, prompts_dst / f.name, overwrite=overwrite)
        count += 1

    log.success(f"Copied {count} prompt(s) to .archon/prompts/")
    log.step("To customize: edit files directly in .archon/prompts/")


def _step3_lean_lsp_mcp(project_path: Path) -> None:
    """Install lean-lsp MCP server at project scope."""
    log.phase(3, "Installing lean-lsp MCP server (project scope)")

    lean_lsp_dir = _data_path("tools/lean-lsp-mcp")

    for name in _find_global_mcp_lean_lsp():
        log.warn(f"Found conflicting MCP server '{name}' in global config")
        log.step("Disabling for this project — Archon's version will be used instead")
        _run(["claude", "mcp", "remove", name, "-s", "project"], cwd=project_path)
        log.success(f"Disabled '{name}' for this project")

    r = _run(
        ["claude", "mcp", "add", "archon-lean-lsp", "-s", "project", "--",
         "uv", "run", "--directory", str(lean_lsp_dir), "lean-lsp-mcp"],
        cwd=project_path,
    )
    output = r.stdout + r.stderr
    if "already exists" in output.lower():
        log.success("archon-lean-lsp already configured")
    elif r.returncode == 0:
        log.success("archon-lean-lsp added (project scope)")
    else:
        log.error(f"Failed to add archon-lean-lsp: {output.strip()}")


def _step4_skills(project_path: Path) -> None:
    """Install Archon skills via plugin marketplace."""
    log.phase(4, "Installing Archon skills")

    home = Path.home()
    skills_dir = _data_path("skills")
    plugin_json_path = skills_dir / "lean4" / ".claude-plugin" / "plugin.json"

    if not plugin_json_path.exists():
        log.error("Archon lean4 skills not found in package data")
        log.step(f"Searched at {plugin_json_path}")
        log.step("The installation may be incomplete — try reinstalling")
        raise typer.Exit(1)

    (project_path / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (project_path / ".claude" / "rules").mkdir(parents=True, exist_ok=True)

    # 4a: Register archon-local marketplace
    log.step("Registering archon-local marketplace")
    market_needs_update = True
    r = _run(["claude", "plugin", "marketplace", "list"])
    if "archon-local" in (r.stdout or ""):
        known_path = home / ".claude" / "plugins" / "known_marketplaces.json"
        data = _read_json(known_path)
        current = data.get("archon-local", {}).get("source", {}).get("path", "")
        if current == str(skills_dir):
            log.success("archon-local marketplace already registered")
            market_needs_update = False
        else:
            log.warn(f"archon-local points to {current}, updating…")
            _run(["claude", "plugin", "marketplace", "remove", "archon-local"])

    if market_needs_update:
        r = _run(["claude", "plugin", "marketplace", "add", str(skills_dir)])
        output = r.stdout + r.stderr
        if r.returncode == 0 or "already" in output.lower():
            log.success("Registered archon-local marketplace")
        else:
            log.error(f"Failed to register marketplace: {output.strip()}")
            raise typer.Exit(1)

    # 4b: Install lean4 plugin at project scope
    log.step("Installing lean4 plugin (project scope)")
    plugin_data = _read_json(plugin_json_path)
    plugin_version = plugin_data.get("version", "4.4.0")
    cache_dir = home / ".claude" / "plugins" / "cache" / "archon-local" / "lean4" / plugin_version

    installed_json = home / ".claude" / "plugins" / "installed_plugins.json"
    installed_data = _read_json(installed_json)
    installed_here = any(
        entry.get("projectPath") == str(project_path)
        for entry in installed_data.get("plugins", {}).get("lean4@archon-local", [])
    )

    if not installed_here:
        r = _run(
            ["claude", "plugin", "install", "lean4@archon-local", "--scope", "project"],
            cwd=project_path,
        )
        output = r.stdout + r.stderr
        if "success" in output.lower() or r.returncode == 0:
            log.success("lean4@archon-local installed (project scope)")
        else:
            log.error(f"Failed to install lean4@archon-local: {output.strip()}")
            raise typer.Exit(1)
    else:
        log.success("lean4@archon-local already installed for this project")

    # 4c: Copy informal agent tool into project
    log.step("Copying informal agent tool")
    tools_dir = project_path / ".claude" / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)
    agent_src = _data_path("tools/informal_agent.py")
    agent_dst = tools_dir / "archon-informal-agent.py"
    if agent_src.exists():
        _copy_file(agent_src, agent_dst, overwrite=True)
        log.success("Informal agent copied to .claude/tools/")
    else:
        log.warn("Informal agent not found in package data — skipping")


def _step5_disable_conflicting_plugins(project_path: Path) -> None:
    """Detect and disable conflicting global lean4-skills for this project."""
    log.phase(5, "Checking for conflicting global lean4-skills")

    conflicting = _find_global_lean4_plugins()
    if not conflicting:
        log.success("No conflicting global lean4-skills detected")
        return

    log.warn(f"Found {len(conflicting)} conflicting plugin(s) in global config:")
    for name in conflicting:
        log.step(f"  {name}")

    for name in conflicting:
        r = _run(
            ["claude", "plugin", "disable", name, "--scope", "project"],
            cwd=project_path,
        )
        if r.returncode == 0:
            log.success(f"Disabled '{name}' for this project")
        else:
            log.warn(f"Could not auto-disable '{name}'")

    log.step("Your global lean4-skills is untouched in all other projects")


def _step6_interactive_claude(project_path: Path, state_dir: Path) -> None:
    """Launch interactive Claude Code session if still in init stage."""
    stage = _parse_stage(state_dir / "PROGRESS.md")
    project_name = project_path.name

    if stage != "init":
        log.success(f"Init already complete — current stage: {stage}")
        log.step(f"Next: archon loop {project_path}")
        return

    log.header(f"Initializing project: {project_name}")
    log.step("Claude will check the project state and guide you through setup")

    prompt = textwrap.dedent(f"""\
        You are in the init stage for project '{project_name}' at {project_path}. \
        Read {state_dir}/CLAUDE.md, then read {state_dir}/prompts/init.md and follow \
        its instructions. Project state files are in {state_dir}/. Write PROGRESS.md \
        and other state files there, not in the project directory.

        IMPORTANT: After checking the project state, do NOT write initial objectives \
        on your own. Instead, propose what you think the objectives should be, then \
        ask the user to confirm or adjust before writing them to PROGRESS.md. Wait \
        for the user's reply.

        When the user has confirmed and you have finished the init steps, run \
        /archon-lean4:doctor to verify the full setup before exiting.""")

    subprocess.run(
        ["claude", "--dangerously-skip-permissions", "--permission-mode",
         "bypassPermissions", prompt],
        cwd=project_path,
    )

    new_stage = _parse_stage(state_dir / "PROGRESS.md")
    if new_stage == "init":
        log.warn("Stage is still 'init' — setup may not be complete")
        log.step(f"Re-run: archon init {project_path}")
    else:
        log.success(f"Init complete — stage is now: {new_stage}")
        log.step(f"Next: archon loop {project_path}")


# ── main command ──────────────────────────────────────────────────────


def init(
    project_path: str = typer.Argument(
        None,
        help="Path to Lean project (directory containing lakefile.lean/toml). "
        "If omitted, prompts for a name and creates the project.",
    ),
) -> None:
    """
    Initialize a new Archon project.

    Creates .archon/ inside the target project with state files, copied
    prompts, skills, MCP server, and launches Claude for initial setup.

    You can add context files (pdf, markdown, etc.) directly in the project directory, and Claude will be able to read them during the init session.

    [bold]Examples of use:[/bold]
      [cyan]archon init .[/cyan]                          Initialize the current directory.
      [cyan]archon init /path/to/lean-project[/cyan]      Initialize an existing external project.
    """
    log.header("archon init")

    if project_path is None:
        log.info("No project path specified")
        log.step("Enter a name to create a new project,")
        log.step("or Ctrl-C and re-run with: archon init /path/to/project")
        name = typer.prompt("  Project name")
        if not name:
            log.error("No project name entered")
            raise typer.Exit(1)
        resolved = Path.cwd() / name
        resolved.mkdir(parents=True, exist_ok=True)
        log.success(f"Created project at {resolved}")
    else:
        resolved = Path(project_path).resolve()
        if not resolved.exists():
            resolved.mkdir(parents=True, exist_ok=True)
            log.success(f"Created directory {resolved}")

    state_dir = resolved / ".archon"

    log.key_value({
        "Project": str(resolved),
        "State dir": str(state_dir),
    })

    if not _has("claude"):
        log.error("Claude Code is not installed")
        log.step("Run: archon setup")
        raise typer.Exit(1)

    _step1_state_dir(resolved, state_dir)
    _step2_copy_prompts(state_dir)
    _step3_lean_lsp_mcp(resolved)
    _step4_skills(resolved)
    _step5_disable_conflicting_plugins(resolved)
    _step6_interactive_claude(resolved, state_dir)
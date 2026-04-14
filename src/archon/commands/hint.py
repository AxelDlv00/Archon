"""Manage user hints in USER_HINTS.md."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer

from archon import log


# ── constants ─────────────────────────────────────────────────────────


_HINTS_HEADER = """\
# User Hints

Provers never read this file — the plan agent translates hints into concrete objectives.

"""

# Matches hint lines written by this tool: "- [timestamp] text"
_HINT_RE = re.compile(r"^- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] (.+)$")


# ── helpers ───────────────────────────────────────────────────────────


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _state_dir(project_path: str) -> Path:
    resolved = Path(project_path).resolve()
    state_dir = resolved / ".archon"
    if not state_dir.exists():
        log.error(f"No .archon/ directory found in {resolved}")
        log.step(f"Run: archon init {project_path}")
        raise typer.Exit(1)
    return state_dir


def _hints_file(state_dir: Path) -> Path:
    f = state_dir / "USER_HINTS.md"
    if not f.exists():
        f.write_text(_HINTS_HEADER)
    return f


def _read_hints(hints_file: Path) -> tuple[str, list[str]]:
    """Return (header_block, [hint_line, ...])."""
    lines = hints_file.read_text().splitlines(keepends=True)
    header_lines: list[str] = []
    hint_lines: list[str] = []
    for line in lines:
        if _HINT_RE.match(line.rstrip()):
            hint_lines.append(line.rstrip())
        else:
            header_lines.append(line)
    header = "".join(header_lines).rstrip()
    return header, hint_lines


def _write_hints(hints_file: Path, header: str, hints: list[str]) -> None:
    body = "\n".join(hints)
    hints_file.write_text(header + ("\n\n" + body + "\n" if hints else "\n"))


def _parse_indices(spec: str, max_n: int) -> list[int]:
    """Parse '2,3,5' or '2-5' or '1,3-5,7' into a sorted list of 1-based indices."""
    indices: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            try:
                lo, hi = part.split("-", 1)
                indices.update(range(int(lo), int(hi) + 1))
            except ValueError:
                log.error(f"Invalid range: '{part}'. Use e.g. '2-5'.")
                raise typer.Exit(1)
        else:
            try:
                indices.add(int(part))
            except ValueError:
                log.error(f"Invalid index: '{part}'. Must be a number.")
                raise typer.Exit(1)

    bad = [i for i in indices if not (1 <= i <= max_n)]
    if bad:
        log.error(f"Index/indices out of range: {bad}. Valid range: 1–{max_n}.")
        raise typer.Exit(1)

    return sorted(indices)


# ── app ───────────────────────────────────────────────────────────────


app = typer.Typer(
    help="Manage plan-agent hints in USER_HINTS.md.",
    invoke_without_command=True,
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback(invoke_without_command=True)
def hint(
    ctx: typer.Context,
    hint_text: Optional[str] = typer.Argument(
        None,
        help="Hint text to add (adds a plan hint when no subcommand is given).",
    ),
    project_path: str = typer.Option(
        ".", "--project", "-p", help="Path to the Lean project."
    ),
) -> None:
    """Manage plan-agent hints in USER_HINTS.md.

    The plan agent reads USER_HINTS.md at the start of each iteration,
    acts on every hint, then clears the file automatically.
    Use hints for strategic course corrections between iterations.

    
    [bold]Subcommands:[/bold]
      [cyan]archon hint \"...\"[/cyan]            Add a hint
      [cyan]archon hint show[/cyan]               List current hints (numbered)
      [cyan]archon hint clear 2,3,5[/cyan]        Remove hints 2, 3 and 5
      [cyan]archon hint clear 2-5[/cyan]          Remove hints 2 through 5
      [cyan]archon hint clear 1,3-5,7[/cyan]      Mixed format also works
      [cyan]archon hint clear all[/cyan]          Remove all hints

    For prover hints (/- USER: ... -/ comments) or permanent prompt edits,
    modify the files directly:
      • Prover hints  →  add /- USER: your hint -/ in the .lean file
      • Prompt edits  →  edit .archon/prompts/*.md
    """
    if ctx.invoked_subcommand is not None:
        return

    if not hint_text:
        # No subcommand and no text: show help
        print(ctx.get_help())
        return

    sd = _state_dir(project_path)
    hf = _hints_file(sd)
    header, hints = _read_hints(hf)

    entry = f"- [{_utcnow()}] {hint_text}"
    hints.append(entry)
    _write_hints(hf, header, hints)

    n = len(hints)
    log.success(f"Hint #{n} added:")
    log.step(hint_text)
    log.info("The plan agent will act on this at the start of the next iteration.")


@app.command("show")
def hint_show(
    project_path: str = typer.Option(
        ".", "--project", "-p", help="Path to the Lean project."
    ),
) -> None:
    """List current hints, numbered."""
    sd = _state_dir(project_path)
    hf = _hints_file(sd)
    _, hints = _read_hints(hf)

    if not hints:
        log.info("No hints pending.")
        return

    log.rule(f"Pending hints ({len(hints)})")
    for i, h in enumerate(hints, 1):
        # Strip the timestamp for readability, keep the text
        m = _HINT_RE.match(h)
        text = m.group(1) if m else h
        ts_m = re.search(r"\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]", h)
        ts = ts_m.group(1) if ts_m else ""
        print(f"  [{i}] {text}  \033[2m({ts})\033[0m")


@app.command("clear")
def hint_clear(
    spec: str = typer.Argument(
        ...,
        help=(
            "Hints to remove. Formats: '2', '2,3,5', '2-5', '1,3-5,7', or 'all'."
        ),
    ),
    project_path: str = typer.Option(
        ".", "--project", "-p", help="Path to the Lean project."
    ),
) -> None:
    """Remove one or more hints by number.

    \b
    Examples:
      archon hint clear 2
      archon hint clear 2,3,5
      archon hint clear 2-5
      archon hint clear 1,3-5,7
      archon hint clear all
    """
    sd = _state_dir(project_path)
    hf = _hints_file(sd)
    header, hints = _read_hints(hf)

    if not hints:
        log.info("No hints to clear.")
        return

    if spec.strip().lower() == "all":
        _write_hints(hf, header, [])
        log.success(f"Cleared all {len(hints)} hint(s).")
        return

    indices = _parse_indices(spec, len(hints))
    removed = [hints[i - 1] for i in indices]
    remaining = [h for i, h in enumerate(hints, 1) if i not in set(indices)]
    _write_hints(hf, header, remaining)

    log.success(f"Removed {len(removed)} hint(s):")
    for h in removed:
        m = _HINT_RE.match(h)
        log.step(m.group(1) if m else h)
    if remaining:
        log.info(f"{len(remaining)} hint(s) still pending.")
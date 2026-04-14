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
    sd = resolved / ".archon"
    if not sd.exists():
        log.error(f"No .archon/ directory found in {resolved}")
        log.step(f"Run: archon init {project_path}")
        raise typer.Exit(1)
    return sd


def _hints_file(sd: Path) -> Path:
    f = sd / "USER_HINTS.md"
    if not f.exists():
        f.write_text(_HINTS_HEADER)
    return f


def _read_hints(hf: Path) -> tuple[str, list[str]]:
    """Return (header_block, [hint_line, ...])."""
    header_lines: list[str] = []
    hint_lines: list[str] = []
    for line in hf.read_text().splitlines(keepends=True):
        if _HINT_RE.match(line.rstrip()):
            hint_lines.append(line.rstrip())
        else:
            header_lines.append(line)
    return "".join(header_lines).rstrip(), hint_lines


def _write_hints(hf: Path, header: str, hints: list[str]) -> None:
    body = "\n".join(hints)
    hf.write_text(header + ("\n\n" + body + "\n" if hints else "\n"))


def _parse_indices(spec: str, max_n: int) -> list[int]:
    """Parse '2', '2,3,5', '2-5', or '1,3-5,7' into sorted 1-based indices."""
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


def _do_add(hint_text: str, hf: Path) -> None:
    header, hints = _read_hints(hf)
    hints.append(f"- [{_utcnow()}] {hint_text}")
    _write_hints(hf, header, hints)
    log.success(f"Hint #{len(hints)} added:")
    log.step(hint_text)
    log.info("The plan agent will act on this at the start of the next iteration.")


def _do_show(hf: Path) -> None:
    _, hints = _read_hints(hf)
    if not hints:
        log.info("No hints pending.")
        return
    log.rule(f"Pending hints ({len(hints)})")
    for i, h in enumerate(hints, 1):
        m = _HINT_RE.match(h)
        text = m.group(1) if m else h
        ts_m = re.search(r"\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]", h)
        ts = ts_m.group(1) if ts_m else ""
        print(f"  [{i}] {text}  \033[2m({ts})\033[0m")


def _do_clear(spec: str, hf: Path) -> None:
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


# ── command ───────────────────────────────────────────────────────────


def hint(
    action: str = typer.Argument(
        ...,
        help="Action: 'add <text>', 'show', or 'clear <spec>'.",
    ),
    extra: Optional[str] = typer.Argument(
        None,
        help="For 'add': hint text. For 'clear': indices e.g. '2', '2,3,5', '2-5', 'all'.",
    ),
    project_path: str = typer.Option(
        ".", "--project", "-p", help="Path to the Lean project."
    ),
) -> None:
    """Manage plan-agent hints in USER_HINTS.md.

    \b
    The plan agent reads USER_HINTS.md at the start of each iteration,
    acts on every hint, then clears the file automatically.

    \b
    Commands:
      archon hint add "..."          Add a hint
      archon hint show               List current hints (numbered)
      archon hint clear 2            Remove hint 2
      archon hint clear 2,3,5        Remove hints 2, 3 and 5
      archon hint clear 2-5          Remove hints 2 through 5
      archon hint clear all          Remove all hints

    \b
    For prover hints or permanent prompt edits, modify the files directly:
      Prover hints  ->  add /- USER: your hint -/ in the .lean file
      Prompt edits  ->  edit .archon/prompts/*.md
    """
    sd = _state_dir(project_path)
    hf = _hints_file(sd)

    match action.lower():
        case "add":
            if not extra:
                log.error("Usage: archon hint add \"your hint text\"")
                raise typer.Exit(1)
            _do_add(extra, hf)

        case "show":
            _do_show(hf)

        case "clear":
            if not extra:
                log.error("Usage: archon hint clear <spec>  (e.g. '2', '2,3,5', '2-5', 'all')")
                raise typer.Exit(1)
            _do_clear(extra, hf)

        case _:
            log.error(f"Unknown action '{action}'. Use: add, show, clear.")
            raise typer.Exit(1)
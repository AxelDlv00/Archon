"""Project layout detection and deterministic bootstrap.

`ProjectLayout` describes what's in a directory *right now*.
`ProjectBootstrap` takes that layout and gets it into a known-good shape
(lake + git + mathlib + blueprint, gitignore entries, references/ dir).
`WorkspaceTemplates` renders README.md and references/summary.md skeletons.

Claude's job, after this module has run, is purely semantic: verify the
setup, decide which loose files belong in references/, fill in the prose
sections of README.md and summary.md, and propose initial objectives.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from archon.commands.tooling.blueprint import Blueprint, BlueprintAnswers
from archon.commands.tooling.git import Git
from archon.commands.tooling.lake import Lake
from archon.commands.tooling.stage import StageReport, scan_project


# File extensions that we consider "informal / reference material" and
# that should live under references/ rather than at the project root.
REFERENCE_EXTS = {".pdf", ".tex", ".bib"}
# Markdown files that aren't obviously part of the project (README, CHANGELOG,
# LICENSE) are also treated as references.
_MD_KEEP_AT_ROOT = {"readme.md", "changelog.md", "license.md", "contributing.md"}


# ── layout detection ──────────────────────────────────────────────────


@dataclass
class ProjectLayout:
    """A snapshot of what exists in the project directory."""
    path: Path
    has_lakefile: bool
    lakefile_kind: str | None            # "lean" | "toml" | None
    has_mathlib: bool
    has_git: bool
    has_commits: bool
    has_blueprint: bool
    has_references_dir: bool
    has_readme: bool
    lean_files: list[Path] = field(default_factory=list)
    loose_references: list[Path] = field(default_factory=list)
    # Present only after bootstrap runs scan_project():
    stage_report: StageReport | None = None

    @classmethod
    def inspect(cls, project_path: str | Path) -> "ProjectLayout":
        path = Path(project_path).resolve()
        path.mkdir(parents=True, exist_ok=True)

        lake = Lake(path)
        info = lake.lakefile_info()
        git = Git(path, auto_init=False)
        bp = Blueprint(path)

        lean_files = [
            p for p in path.rglob("*.lean")
            if not any(part in {".lake", "lake-packages", ".git", ".archon", ".claude"}
                       for part in p.relative_to(path).parts)
        ]

        loose = _find_loose_references(path)

        return cls(
            path=path,
            has_lakefile=info.path is not None,
            lakefile_kind=info.kind,
            has_mathlib=info.has_mathlib,
            has_git=git.is_repo(),
            has_commits=git.is_repo() and git.has_commits(),
            has_blueprint=bp.is_initialized(),
            has_references_dir=(path / "references").is_dir(),
            has_readme=(path / "README.md").exists(),
            lean_files=lean_files,
            loose_references=loose,
        )


def _find_loose_references(project_path: Path) -> list[Path]:
    """Return informal files sitting at the project root that should be in references/."""
    loose: list[Path] = []
    for child in project_path.iterdir():
        if not child.is_file():
            continue
        ext = child.suffix.lower()
        name = child.name.lower()
        if ext in REFERENCE_EXTS:
            loose.append(child)
            continue
        if ext == ".md" and name not in _MD_KEEP_AT_ROOT:
            # Non-standard markdown at the root is probably notes/sketches.
            loose.append(child)
    return loose


# ── bootstrap orchestration ───────────────────────────────────────────


@dataclass
class BootstrapOptions:
    """Flags controlling what the bootstrap will do."""
    init_lake: bool = True
    add_mathlib: bool = True
    init_blueprint: bool = True    # still skipped if `leanblueprint` isn't installed
    fetch_mathlib_cache: bool = True
    do_initial_build: bool = False  # turn on at your own risk; Mathlib is slow
    project_title: str = ""        # used as Lean package name / blueprint title
    author: str = ""
    github_url: str = ""
    website_url: str = ""
    api_url: str = ""


@dataclass
class BootstrapReport:
    """What the bootstrap actually did. Surfaces to the user + Claude."""
    actions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    stage_report: StageReport | None = None

    def add(self, msg: str) -> None:
        self.actions.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def skip(self, msg: str) -> None:
        self.skipped.append(msg)


class ProjectBootstrap:
    """Deterministic setup of a Lean formalization project.

    Safe to re-run on an already-initialized project — every step is
    idempotent. The idea is that Claude can call `run()` confidently
    without needing to know the project state.
    """

    def __init__(self, project_path: str | Path, options: BootstrapOptions | None = None):
        self.path = Path(project_path).resolve()
        self.options = options or BootstrapOptions()
        self.lake = Lake(self.path)
        self.git = Git(self.path, auto_init=True)
        self.blueprint = Blueprint(self.path)

    # ── main entry point ──────────────────────────────────────────────

    def run(self) -> BootstrapReport:
        report = BootstrapReport()

        self._ensure_gitignore(report)
        self._ensure_git(report)
        self._ensure_lake(report)
        self._ensure_mathlib(report)
        self._ensure_blueprint(report)
        self._ensure_workspace_dirs(report)
        self._commit_bootstrap_changes(report)
        self._scan_stage(report)

        return report

    # ── individual steps ──────────────────────────────────────────────

    def _ensure_gitignore(self, report: BootstrapReport) -> None:
        entries = [
            (".lake/", "Lake build artifacts"),
            (".archon/", "Archon state directory"),
        ]
        for entry, comment in entries:
            if self.git.ensure_gitignore_entry(entry, comment=comment):
                report.add(f"Added '{entry}' to .gitignore")

    def _ensure_git(self, report: BootstrapReport) -> None:
        if not self.git.is_repo():
            report.warn("git init was expected to have run in Git.__init__")
            return
        if self.git.ensure_initial_commit():
            report.add("Created initial empty git commit")

    def _ensure_lake(self, report: BootstrapReport) -> None:
        if not self.options.init_lake:
            report.skip("lake init (disabled by options)")
            return

        info = self.lake.lakefile_info()
        if info.path is not None:
            report.add(f"Lake project already present ({info.kind})")
            return

        name = self.options.project_title or self.path.name
        try:
            self.lake.init_project(project_name=name, template="math")
            report.add(f"Ran `lake init {name} math`")
        except Exception as e:
            # If the dir isn't empty lake init may complain; surface it.
            report.warn(f"lake init failed: {e}")

    def _ensure_mathlib(self, report: BootstrapReport) -> None:
        if not self.options.add_mathlib:
            report.skip("Mathlib dependency (disabled by options)")
            return

        info = self.lake.lakefile_info()
        if info.path is None:
            report.warn("Cannot add Mathlib: no lakefile was created")
            return

        if info.has_mathlib:
            report.add("Mathlib dependency already declared")
        else:
            try:
                modified = self.lake.add_mathlib_dependency()
                if modified:
                    report.add(f"Added Mathlib dependency to {info.path.name}")
            except Exception as e:
                report.warn(f"Failed to add Mathlib dependency: {e}")
                return

        try:
            self.lake.update()
            report.add("Ran `lake update`")
        except Exception as e:
            report.warn(f"`lake update` failed: {e}")
            return

        if self.options.fetch_mathlib_cache:
            note = self.lake.get_mathlib_cache()
            if note.startswith("(mathlib cache unavailable"):
                report.warn(f"Mathlib cache not fetched — {note}")
            else:
                report.add("Fetched Mathlib olean cache")

        if self.options.do_initial_build:
            try:
                self.lake.build()
                report.add("Ran `lake build`")
            except Exception as e:
                report.warn(f"`lake build` failed (this may be expected for a fresh project): {e}")

    def _ensure_blueprint(self, report: BootstrapReport) -> None:
        if not self.options.init_blueprint:
            report.skip("leanblueprint scaffolding (disabled by options)")
            return

        if self.blueprint.is_initialized():
            report.add("Blueprint already initialized")
            return

        if not Blueprint.available():
            report.warn("`leanblueprint` is not on PATH — skipping scaffold (run: archon setup)")
            return

        # `leanblueprint new` insists on an existing commit.
        self.git.ensure_initial_commit()

        answers = BlueprintAnswers(
            project_title=self.options.project_title
                or _titlecase(self.path.name),
            author=self.options.author,
            github_url=self.options.github_url,
            website_url=self.options.website_url,
            api_url=self.options.api_url,
        )
        try:
            self.blueprint.initialize_new(answers=answers)
            report.add("Scaffolded blueprint via `leanblueprint new`")
        except Exception as e:
            report.warn(f"`leanblueprint new` failed: {e}")

    def _ensure_workspace_dirs(self, report: BootstrapReport) -> None:
        refs = self.path / "references"
        if not refs.exists():
            refs.mkdir(parents=True, exist_ok=True)
            report.add("Created references/ directory")

    def _commit_bootstrap_changes(self, report: BootstrapReport) -> None:
        if self.git.is_dirty():
            made = self.git.add_and_commit(
                "chore: bootstrap Lean project (lake, Mathlib, blueprint, workspace)"
            )
            if made:
                report.add("Committed bootstrap changes")

    def _scan_stage(self, report: BootstrapReport) -> None:
        try:
            report.stage_report = scan_project(self.path)
        except Exception as e:
            report.warn(f"Stage scan failed: {e}")


# ── workspace templates ───────────────────────────────────────────────


class WorkspaceTemplates:
    """Writes skeleton files that Claude then fills in with prose.

    Keeping the skeletons here (not in Claude) means README/summary.md
    structure stays consistent across all Archon projects.
    """

    README_TEMPLATE = """\
# {title}

<!-- archon:readme -->
<!-- Claude fills in the prose sections below. Keep the section headers. -->

## Project

<!-- One paragraph: what is being formalized and why. -->

## References

See [`references/summary.md`](references/summary.md) for a description of each source.

## Structure

- `{lean_root}/` — main Lean source
- `blueprint/` — leanblueprint source (build with `leanblueprint pdf` and `leanblueprint web`)
- `references/` — PDFs, papers, and informal notes backing the formalization
- `.archon/` — agent state (not committed)

## How to build

```bash
lake exe cache get   # download Mathlib olean cache
lake build           # compile the project
```

## How to run the formalization loop

```bash
archon loop .
```

This launches the plan → prove → review loop and opens a dashboard.
"""

    SUMMARY_TEMPLATE = """\
# References

<!-- archon:references-summary -->
<!-- One short line per file describing what it is and which parts of the formalization it backs. -->
<!-- Claude maintains this file; keep entries in sync with the contents of this directory. -->

| File | Description | 
| ---- | ----------- |
"""

    def __init__(self, project_path: str | Path):
        self.path = Path(project_path).resolve()

    def ensure_readme(self, title: str | None = None, lean_root: str | None = None) -> bool:
        """Write README.md if missing. Returns True iff it was created."""
        readme = self.path / "README.md"
        if readme.exists():
            return False
        readme.write_text(
            self.README_TEMPLATE.format(
                title=title or _titlecase(self.path.name),
                lean_root=lean_root or _guess_lean_root(self.path) or "src",
            ),
            encoding="utf-8",
        )
        return True

    def ensure_references_summary(self) -> bool:
        """Write references/summary.md if missing. Returns True iff it was created."""
        refs = self.path / "references"
        refs.mkdir(parents=True, exist_ok=True)
        summary = refs / "summary.md"
        if summary.exists():
            return False
        summary.write_text(self.SUMMARY_TEMPLATE, encoding="utf-8")
        return True


# ── helpers ───────────────────────────────────────────────────────────


def _titlecase(s: str) -> str:
    return s.replace("_", " ").replace("-", " ").strip().title() or "Project"


def _guess_lean_root(project_path: Path) -> str | None:
    """Best-effort guess of the main Lean source directory.

    Lake's default layout puts user code in `<PackageName>/`, with a
    sibling `<PackageName>.lean` import file. We look for that pattern.
    """
    candidates = [
        p for p in project_path.iterdir()
        if p.is_dir() and (project_path / f"{p.name}.lean").exists()
        and p.name not in {".lake", ".git", ".archon", ".claude", "blueprint", "references"}
    ]
    if len(candidates) == 1:
        return candidates[0].name
    return None
"""Per-iteration finalization: git commit, lake build, blueprint web.

All steps are non-fatal — if `lake build` fails because a prover broke the
project, we warn and keep going; the next iteration's plan agent will see
the red state in the report.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from archon import log
from archon.commands.tooling.blueprint import Blueprint
from archon.commands.tooling.git import Git
from archon.commands.tooling.lake import Lake


@dataclass
class IterationFinalizationReport:
    """What happened during this iteration's finalize step."""
    git_commit_sha: str | None = None
    git_commit_skipped: bool = False
    lake_build_ok: bool | None = None   
    lake_build_error: str | None = None
    lake_build_secs: int | None = None
    blueprint_web_ok: bool | None = None
    blueprint_web_error: str | None = None
    blueprint_web_secs: int | None = None
    warnings: list[str] = field(default_factory=list)

    def to_meta_dict(self) -> dict[str, object]:
        """Return a dict suitable for merging into the iteration's meta.json."""
        d: dict[str, object] = {}
        if self.git_commit_sha is not None:
            d["finalize.git.sha"] = self.git_commit_sha
        if self.git_commit_skipped:
            d["finalize.git.skipped"] = True
        if self.lake_build_ok is not None:
            d["finalize.lake.ok"] = self.lake_build_ok
            d["finalize.lake.durationSecs"] = self.lake_build_secs or 0
            if self.lake_build_error:
                d["finalize.lake.error"] = self.lake_build_error[:500]
        if self.blueprint_web_ok is not None:
            d["finalize.blueprint.ok"] = self.blueprint_web_ok
            d["finalize.blueprint.durationSecs"] = self.blueprint_web_secs or 0
            if self.blueprint_web_error:
                d["finalize.blueprint.error"] = self.blueprint_web_error[:500]
        return d


class IterationFinalizer:
    """Run non-fatal cleanup/verification at the end of each loop iteration.

    Three steps, all best-effort:
      1. `git add -A && git commit -m "archon: iter N (stage=...)"` if anything changed
      2. `lake build` — surface errors, don't raise
      3. `leanblueprint web` — surface errors, don't raise
    """

    def __init__(
        self,
        project_path: str | Path,
        *,
        do_git: bool = True,
        do_lake_build: bool = True,
        do_blueprint_web: bool = True,
    ):
        self.project_path = Path(project_path).resolve()
        self.do_git = do_git
        self.do_lake_build = do_lake_build
        self.do_blueprint_web = do_blueprint_web

    def run(
        self,
        *,
        iter_num: int,
        stage: str,
        sorry_count: int | None = None,
    ) -> IterationFinalizationReport:
        report = IterationFinalizationReport()

        if self.do_git:
            self._commit(report, iter_num, stage, sorry_count)

        if self.do_lake_build:
            self._lake_build(report)

        if self.do_blueprint_web:
            self._blueprint_web(report)

        return report

    # ── steps ─────────────────────────────────────────────────────────

    def _commit(
        self,
        report: IterationFinalizationReport,
        iter_num: int,
        stage: str,
        sorry_count: int | None,
    ) -> None:
        try:
            git = Git(self.project_path, auto_init=False)
        except Exception as e:
            report.warnings.append(f"git: {e}")
            report.git_commit_skipped = True
            return

        if not git.is_repo():
            report.git_commit_skipped = True
            return

        if not git.is_dirty():
            report.git_commit_skipped = True
            log.info("No changes to commit this iteration")
            return

        # Commit-msg keeps a compact, greppable format so you can track
        # progress through `git log --oneline`.
        parts = [f"archon: iter {iter_num:03d}", f"stage={stage}"]
        if sorry_count is not None:
            parts.append(f"sorry={sorry_count}")
        msg = " ".join(parts)

        # Skip .archon/logs/**/*.raw.jsonl-type firehose files if the user
        # already .gitignore'd .archon/. If not, git will still commit them;
        # the bootstrap step is expected to have added .archon/ to .gitignore.
        try:
            made = git.add_and_commit(msg)
        except Exception as e:
            report.warnings.append(f"git commit failed: {e}")
            report.git_commit_skipped = True
            return

        if not made:
            report.git_commit_skipped = True
            return

        # Read back the SHA.
        try:
            r = git._run(["rev-parse", "--short", "HEAD"], check=False)
            report.git_commit_sha = r.stdout.strip() or None
        except Exception:
            pass

        log.success(f"Committed: {msg}" + (f" ({report.git_commit_sha})" if report.git_commit_sha else ""))

    def _lake_build(self, report: IterationFinalizationReport) -> None:
        if not Lake.available():
            report.warnings.append("lake not on PATH — skipping build")
            return

        lake = Lake(self.project_path)
        info = lake.lakefile_info()
        if info.path is None:
            report.warnings.append("no lakefile found — skipping build")
            return

        start = time.monotonic()
        try:
            lake.build()
            report.lake_build_ok = True
            report.lake_build_secs = int(time.monotonic() - start)
            log.success(f"lake build ok ({report.lake_build_secs}s)")
        except Exception as e:
            report.lake_build_ok = False
            report.lake_build_secs = int(time.monotonic() - start)
            full_error = str(e)
            report.lake_build_error = full_error

            # Full error can be thousands of lines of Lean diagnostics.
            # We keep a trimmed version for the terminal and persist the
            # full version to .archon/last_lake_build.log so the plan
            # agent can read it in the next iteration.
            state_dir = self.project_path / ".archon"
            if state_dir.is_dir():
                try:
                    (state_dir / "last_lake_build.log").write_text(
                        full_error, encoding="utf-8"
                    )
                except OSError:
                    pass

            preview = full_error.strip().splitlines()
            # Prefer the last error line over the trailing "command exited"
            # summary; skim backwards for something that looks like an error.
            snippet = ""
            for line in reversed(preview):
                low = line.lower()
                if "error" in low or "failed" in low:
                    snippet = line.strip()[:300]
                    break
            if not snippet and preview:
                snippet = preview[-1].strip()[:300]

            log.warn(f"lake build failed ({report.lake_build_secs}s): {snippet or 'unknown'}")
            log.step(f"Full output: {state_dir / 'last_lake_build.log'}")
            log.step("Continuing — the plan agent will see the error next iteration")

    def _blueprint_web(self, report: IterationFinalizationReport) -> None:
        bp = Blueprint(self.project_path)
        if not bp.is_initialized():
            return
        if not Blueprint.available():
            report.warnings.append("leanblueprint not on PATH — skipping web build")
            return

        start = time.monotonic()
        try:
            bp.web()
            report.blueprint_web_ok = True
            report.blueprint_web_secs = int(time.monotonic() - start)
            log.success(f"leanblueprint web ok ({report.blueprint_web_secs}s)")
        except Exception as e:
            report.blueprint_web_ok = False
            report.blueprint_web_secs = int(time.monotonic() - start)
            report.blueprint_web_error = str(e)
            preview = str(e).strip().splitlines()
            preview_text = " / ".join(preview[-2:])[:300] if preview else "unknown"
            log.warn(f"leanblueprint web failed ({report.blueprint_web_secs}s): {preview_text}")
            log.step("Continuing — the plan agent may need to adjust chapter TeX")
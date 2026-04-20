"""Thin wrapper around `leanblueprint`.

The trickiest thing here is that `leanblueprint new` is an interactive
prompt-style tool. We drive it by piping newline-separated answers on
stdin. Because the number/order of questions can drift between versions,
we keep the answer list explicit and commented so it's easy to re-sync.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


class BlueprintError(RuntimeError):
    def __init__(self, args: list[str], stdout: str, stderr: str, returncode: int):
        super().__init__(
            f"leanblueprint {' '.join(args)} exited with code {returncode}\n"
            f"stdout: {stdout.strip()}\nstderr: {stderr.strip()}"
        )
        self.args = args
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


@dataclass
class BlueprintAnswers:
    """Answers fed to `leanblueprint new` on stdin, in order.

    Empty strings accept the tool's default. Values match the question
    order as of leanblueprint 0.0.18; if upstream changes order, update
    `to_stdin()`.
    """
    project_title: str = ""
    author: str = ""
    github_url: str = ""
    website_url: str = ""
    api_url: str = ""
    doc_class: str = ""          # default: report
    paper: str = ""              # default: a4paper
    show_hide_proofs: str = ""   # default: y
    toc_depth: str = ""          # default: 3
    split_file_level: str = ""   # default: 0
    per_file_toc_depth: str = ""  # default: 0
    proceed: str = "y"            # Proceed with blueprint creation?
    modify_lakefile_checkdecls: str = "y"
    modify_lakefile_docgen: str = "y"
    create_home_page: str = "n"
    configure_ci: str = "n"
    commit_to_git: str = "n"      # we commit ourselves afterwards

    def to_stdin(self) -> str:
        ordered = [
            self.project_title,
            self.author,
            self.github_url,
            self.website_url,
            self.api_url,
            self.doc_class,
            self.paper,
            self.show_hide_proofs,
            self.toc_depth,
            self.split_file_level,
            self.per_file_toc_depth,
            self.proceed,
            self.modify_lakefile_checkdecls,
            self.modify_lakefile_docgen,
            self.create_home_page,
            self.configure_ci,
            self.commit_to_git,
        ]
        return "\n".join(ordered) + "\n"


class Blueprint:
    def __init__(self, repo_path: str | Path):
        self.repo_path = Path(repo_path).resolve()
        self.env = os.environ.copy()

    # ── low-level ─────────────────────────────────────────────────────

    @staticmethod
    def available() -> bool:
        return shutil.which("leanblueprint") is not None

    def _run(
        self,
        args: list[str],
        input_str: str | None = None,
        check: bool = True,
        timeout: int | None = None,
    ) -> subprocess.CompletedProcess:
        result = subprocess.run(
            ["leanblueprint", *args],
            cwd=str(self.repo_path),
            env=self.env,
            input=input_str,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if check and result.returncode != 0:
            raise BlueprintError(args, result.stdout, result.stderr, result.returncode)
        return result

    # ── introspection ─────────────────────────────────────────────────

    def is_initialized(self) -> bool:
        return (self.repo_path / "blueprint").is_dir()

    # ── actions ───────────────────────────────────────────────────────

    def initialize_new(self, answers: BlueprintAnswers | None = None, if_absent: bool = True) -> str:
        """Scaffold a new blueprint via `leanblueprint new`.

        Requires the repo to already have at least one git commit (the tool
        refuses otherwise). Callers should ensure that first.
        """
        if self.is_initialized() and if_absent:
            return "Blueprint already initialized."
        answers = answers or BlueprintAnswers()
        # Some versions of leanblueprint can hang if their git detection
        # picks up something unexpected; cap at 120s to fail fast.
        return self._run(["new"], input_str=answers.to_stdin(), timeout=120).stdout.strip()

    def web(self) -> str:
        return self._run(["web"]).stdout.strip()

    def pdf(self) -> str:
        return self._run(["pdf"]).stdout.strip()

    def checkdecls(self) -> str:
        return self._run(["checkdecls"]).stdout.strip()

    def build_all(self) -> str:
        return self._run(["all"]).stdout.strip()
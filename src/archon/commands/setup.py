"""Install system-level dependencies for Archon."""

import os
import shutil
import subprocess
import sys
from importlib import resources
from pathlib import Path

import typer

from archon import log


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run a command, returning the CompletedProcess."""
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def _run_shell(script: str) -> subprocess.CompletedProcess:
    """Run a shell script string."""
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)


def _has(binary: str) -> bool:
    return shutil.which(binary) is not None


def _version(cmd: list[str]) -> str:
    """Return first line of version output, or 'unknown'."""
    try:
        r = _run(cmd)
        return (r.stdout or r.stderr).strip().splitlines()[0]
    except Exception:
        return "unknown"


def _shell_rc() -> Path | None:
    shell = os.environ.get("SHELL", "")
    if "zsh" in shell:
        return Path.home() / ".zshrc"
    if "bash" in shell:
        return Path.home() / ".bashrc"
    return None


def _data_path(sub_path: str = "") -> Path:
    """Resolve a path inside the bundled archon package."""
    root = resources.files("archon")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _source_nvm() -> None:
    """Load nvm into the current process PATH if installed."""
    nvm_dir = Path.home() / ".nvm"
    nvm_sh = nvm_dir / "nvm.sh"
    if not nvm_sh.exists():
        return
    r = _run_shell(f'source "{nvm_sh}" && dirname "$(nvm which current)"')
    node_bin = r.stdout.strip()
    if node_bin and Path(node_bin).is_dir():
        os.environ["PATH"] = f"{node_bin}{os.pathsep}{os.environ['PATH']}"


def _ensure_path_in_rc() -> None:
    rc = _shell_rc()
    if rc is None or not rc.exists():
        return
    line = 'export PATH="$HOME/.local/bin:$PATH"'
    content = rc.read_text()
    if "$HOME/.local/bin" not in content:
        with rc.open("a") as f:
            f.write(f"\n# Added by Archon setup\n{line}\n")
        log.success(f"Added ~/.local/bin to PATH in {rc}")
        log.step(f"Run: source {rc}")


# ── individual checks ─────────────────────────────────────────────────


def _check_git() -> bool:
    if _has("git"):
        log.success(f"git: {_version(['git', '--version'])}")
        return True

    log.step("Installing git...")
    if _has("apt-get"):
        _run(["sudo", "apt-get", "update", "-qq"])
        _run(["sudo", "apt-get", "install", "-y", "-qq", "git"])
    elif _has("brew"):
        _run(["brew", "install", "git"])
    elif _has("dnf"):
        _run(["sudo", "dnf", "install", "-y", "git"])
    elif _has("pacman"):
        _run(["sudo", "pacman", "-S", "--noconfirm", "git"])

    if _has("git"):
        log.success(f"git installed: {_version(['git', '--version'])}")
        return True
    log.error("git is not installed and could not be auto-installed")
    log.step("Install manually: https://git-scm.com/downloads")
    return False


def _check_python() -> bool:
    v = sys.version_info
    if v >= (3, 10):
        log.success(f"Python: {v.major}.{v.minor}.{v.micro}")
        return True
    log.error(f"Python 3.10+ required, found {v.major}.{v.minor}.{v.micro}")
    log.step("Install: https://www.python.org/downloads/")
    return False


def _check_curl() -> bool:
    if _has("curl"):
        log.success("curl: available")
        return True
    log.step("Installing curl...")
    if _has("apt-get"):
        _run(["sudo", "apt-get", "update", "-qq"])
        _run(["sudo", "apt-get", "install", "-y", "-qq", "curl"])
    elif _has("brew"):
        _run(["brew", "install", "curl"])
    elif _has("dnf"):
        _run(["sudo", "dnf", "install", "-y", "curl"])
    elif _has("pacman"):
        _run(["sudo", "pacman", "-S", "--noconfirm", "curl"])

    if _has("curl"):
        log.success("curl: installed")
        return True
    log.error("curl is required and could not be auto-installed")
    return False


def _check_lean() -> bool:
    elan_bin = Path.home() / ".elan" / "bin"
    if elan_bin.is_dir() and str(elan_bin) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{elan_bin}{os.pathsep}{os.environ['PATH']}"

    ok = True
    for tool in ("elan", "lean", "lake"):
        if _has(tool):
            log.success(f"{tool}: {_version([tool, '--version'])}")
        else:
            ok = False

    if ok:
        return True

    log.step("Installing elan (Lean toolchain manager)...")

    if _has("brew"):
        r = _run(["brew", "install", "elan-init"])
        if r.returncode == 0:
            _run(["elan", "default", "stable"])
    else:
        r = _run_shell("curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y --default-toolchain stable")

    if elan_bin.is_dir():
        os.environ["PATH"] = f"{elan_bin}{os.pathsep}{os.environ['PATH']}"

    ok = True
    for tool in ("elan", "lean", "lake"):
        if _has(tool):
            log.success(f"{tool} installed: {_version([tool, '--version'])}")
        else:
            log.warn(f"{tool} still not found after install")
            ok = False

    if not ok:
        log.error("Lean toolchain installation incomplete")
        log.step("Install manually: curl https://elan.lean-lang.org/elan-init.sh -sSf | sh")
        log.step('Then add to PATH: export PATH="$HOME/.elan/bin:$PATH"')
    return ok


def _check_uv() -> bool:
    if _has("uv"):
        log.success(f"uv: {_version(['uv', '--version'])}")
        _run(["uv", "self", "update"])
        return True
    log.step("Installing uv...")
    r = _run_shell("curl -LsSf https://astral.sh/uv/install.sh | sh")
    if r.returncode != 0:
        log.warn("Standalone installer failed, trying pip...")
        _run([sys.executable, "-m", "pip", "install", "--user", "uv"])
    os.environ["PATH"] = f"{Path.home() / '.local' / 'bin'}{os.pathsep}{os.environ['PATH']}"
    if _has("uv"):
        log.success(f"uv installed: {_version(['uv', '--version'])}")
        _ensure_path_in_rc()
        return True
    log.error("uv installation failed")
    log.step("Install manually: https://docs.astral.sh/uv/getting-started/installation/")
    return False


def _check_tmux() -> bool:
    if _has("tmux"):
        log.success(f"tmux: {_version(['tmux', '-V'])}")
        return True
    log.step("Installing tmux...")
    if _has("apt-get"):
        _run(["sudo", "apt-get", "update", "-qq"])
        _run(["sudo", "apt-get", "install", "-y", "-qq", "tmux"])
    elif _has("brew"):
        _run(["brew", "install", "tmux"])
    elif _has("dnf"):
        _run(["sudo", "dnf", "install", "-y", "tmux"])
    elif _has("pacman"):
        _run(["sudo", "pacman", "-S", "--noconfirm", "tmux"])

    if _has("tmux"):
        log.success(f"tmux installed: {_version(['tmux', '-V'])}")
        return True
    log.warn("Could not install tmux")
    log.step("Install manually: https://github.com/tmux/tmux/wiki/Installing")
    return False


def _check_ripgrep() -> bool:
    if _has("rg"):
        log.success(f"ripgrep: {_version(['rg', '--version'])}")
        return True
    log.step("Installing ripgrep (optional, used for code search)...")
    if _has("apt-get"):
        _run(["sudo", "apt-get", "update", "-qq"])
        _run(["sudo", "apt-get", "install", "-y", "-qq", "ripgrep"])
    elif _has("brew"):
        _run(["brew", "install", "ripgrep"])
    elif _has("dnf"):
        _run(["sudo", "dnf", "install", "-y", "ripgrep"])
    elif _has("pacman"):
        _run(["sudo", "pacman", "-S", "--noconfirm", "ripgrep"])

    if _has("rg"):
        log.success(f"ripgrep installed: {_version(['rg', '--version'])}")
        return True
    log.warn("Could not install ripgrep")
    log.step("Install manually: https://github.com/burntsushi/ripgrep")
    return False


def _check_claude_code() -> bool:
    if _has("claude"):
        log.success(f"Claude Code: {_version(['claude', '--version'])} (update: claude update)")
        return True
    log.step("Installing Claude Code (may take a few minutes)...")
    _run_shell("curl -fsSL https://claude.ai/install.sh | bash")
    os.environ["PATH"] = f"{Path.home() / '.local' / 'bin'}{os.pathsep}{os.environ['PATH']}"
    if _has("claude"):
        log.success(f"Claude Code installed: {_version(['claude', '--version'])}")
        return True
    log.error("Claude Code installation failed")
    log.step("Install manually: https://code.claude.com/docs/en/overview")
    return False


def _check_node() -> bool:
    """Check/install Node.js 18+ via nvm."""
    _source_nvm()

    if _has("node") and _has("npm"):
        r = _run(["node", "-v"])
        version_str = (r.stdout or "").strip().lstrip("v")
        try:
            major = int(version_str.split(".")[0])
        except (ValueError, IndexError):
            major = 0
        if major >= 18:
            log.success(f"Node.js: v{version_str}")
            return True
        log.warn(f"Node.js {version_str} is too old (need 18+), upgrading via nvm...")

    nvm_dir = Path.home() / ".nvm"
    nvm_sh = nvm_dir / "nvm.sh"

    if not nvm_sh.exists():
        log.step("Installing nvm (Node Version Manager)...")
        r = _run_shell("curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash")
        if r.returncode != 0:
            log.error("nvm installation failed")
            log.step("Install manually: https://github.com/nvm-sh/nvm")
            return False
        log.success("nvm installed")

    log.step("Installing Node.js via nvm...")
    r = _run_shell(f'source "{nvm_sh}" && nvm install --lts && nvm use --lts')
    if r.returncode != 0:
        log.error(f"Node.js installation via nvm failed: {r.stderr.strip()}")
        log.step("Install manually: https://nodejs.org/")
        return False

    _source_nvm()

    if _has("node") and _has("npm"):
        r = _run(["node", "-v"])
        version_str = (r.stdout or "").strip().lstrip("v")
        log.success(f"Node.js installed: v{version_str}")
        return True

    log.error("Node.js installation succeeded but binaries not found in PATH")
    log.step('Try: source ~/.nvm/nvm.sh && nvm use --lts')
    return False


def _install_dashboard_deps() -> bool:
    """Install npm dependencies for the dashboard (server + client)."""
    ui_dir = _data_path("ui")
    if not ui_dir.exists():
        log.warn("UI files not found in package data — skipping dashboard deps")
        return False

    server_dir = ui_dir / "server"
    client_dir = ui_dir / "client"
    ok = True

    for directory, name in ((server_dir, "server"), (client_dir, "client")):
        package_json = directory / "package.json"
        if not package_json.exists():
            log.warn(f"No package.json in {name} directory — skipping")
            continue

        node_modules = directory / "node_modules"
        lock_marker = node_modules / ".package-lock.json"

        needs_install = False
        if not node_modules.exists():
            needs_install = True
        elif lock_marker.exists() and package_json.stat().st_mtime > lock_marker.stat().st_mtime:
            needs_install = True

        if not needs_install:
            log.success(f"Dashboard {name} dependencies up to date")
            continue

        if not _npm_install(directory, name):
            ok = False

    # Build client if needed
    ok = _build_dashboard_client(client_dir) and ok
    return ok


def _npm_install(directory: Path, name: str, clean: bool = False) -> bool:
    """Run npm install in a directory, optionally cleaning first."""
    if clean:
        node_modules = directory / "node_modules"
        package_lock = directory / "package-lock.json"
        if node_modules.exists():
            log.step(f"Removing {name} node_modules for clean install...")
            import shutil as _shutil
            _shutil.rmtree(node_modules, ignore_errors=True)
        if package_lock.exists():
            package_lock.unlink()

    log.step(f"Installing dashboard {name} dependencies...")
    r = _run(
        ["npm", "install", "--no-fund", "--no-audit", "--loglevel=error"],
        cwd=str(directory),
    )
    if r.returncode != 0:
        log.error(f"Failed to install {name} dependencies: {r.stderr.strip()}")
        return False

    log.success(f"Dashboard {name} dependencies installed")
    return True


def _build_dashboard_client(client_dir: Path) -> bool:
    """Build the dashboard client via vite, with auto-retry on rollup errors."""
    client_dist = client_dir / "dist" / "index.html"
    client_src = client_dir / "src"
    needs_build = False

    if not client_dist.exists():
        needs_build = True
    elif client_src.exists():
        dist_mtime = client_dist.stat().st_mtime
        for f in client_src.rglob("*"):
            if f.is_file() and f.stat().st_mtime > dist_mtime:
                needs_build = True
                break

    if not needs_build:
        log.success("Dashboard client build up to date")
        return True

    if not (client_dir / "node_modules").exists():
        log.warn("Client node_modules missing — skipping build")
        return False

    vite = client_dir / "node_modules" / "vite" / "bin" / "vite.js"
    if not vite.exists():
        log.warn("Vite not found in node_modules — skipping build")
        return False

    log.step("Building dashboard client...")
    r = _run(
        ["node", str(vite), "build", "--logLevel", "warn"],
        cwd=str(client_dir),
    )

    if r.returncode == 0:
        log.success("Dashboard client built")
        return True

    # Check for the known rollup/npm optional dependency bug
    stderr = r.stderr or ""
    if "rollup" in stderr.lower() and ("cannot find module" in stderr.lower() or "npm has a bug" in stderr.lower()):
        log.warn("Hit known rollup/npm optional dependency bug — retrying with clean install")
        if not _npm_install(client_dir, "client", clean=True):
            return False

        log.step("Retrying client build...")
        r = _run(
            ["node", str(vite), "build", "--logLevel", "warn"],
            cwd=str(client_dir),
        )
        if r.returncode == 0:
            log.success("Dashboard client built (after clean reinstall)")
            return True

    log.error(f"Client build failed: {(r.stderr or '').strip()}")
    return False


def _check_api_keys() -> None:
    keys = {
        "OPENAI_API_KEY": "OpenAI",
        "GEMINI_API_KEY": "Gemini",
        "OPENROUTER_API_KEY": "OpenRouter",
    }
    log.info("The informal agent can request proof sketches from external models.")
    log.info("This is optional — everything else works without it.")
    found_any = False
    for var, label in keys.items():
        if os.environ.get(var):
            log.success(f"{var} is set ({label}) : {os.environ[var][:4]}...{os.environ[var][-4:]})")
            found_any = True
        else:
            log.step(f"{var} not set — export {var}=... to enable {label}")
    if not found_any:
        log.warn("No external-model API keys found. Set at least one if you want to use the informal agent.")


# ── main command ──────────────────────────────────────────────────────


def setup() -> None:
    """Install system-level dependencies.

    Checks and auto-installs where possible: git, Python 3.10+, curl,
    elan/lean/lake, uv, tmux, ripgrep, Claude Code, Node.js (via nvm),
    dashboard npm dependencies, and external-model API keys (optional).
    """
    fatal = False

    log.rule("System prerequisites")
    for check in (_check_git, _check_python, _check_curl, _check_lean):
        if not check():
            fatal = True
    if fatal:
        log.error("Required prerequisites missing — fix the errors above and re-run.")
        raise typer.Exit(1)

    log.rule("Python tooling & packages")
    _check_uv()
    _check_tmux()
    _check_ripgrep()

    log.rule("Claude Code")
    _check_claude_code()

    log.rule("Dashboard dependencies")
    node_ok = _check_node()
    if node_ok:
        _install_dashboard_deps()
    else:
        log.warn("Skipping dashboard npm install — Node.js not available")

    log.rule("Informal agent API keys (optional)")
    _check_api_keys()

    log.rule("Setup complete")
    rc = _shell_rc()
    if rc and rc.exists():
        log.warn(f"To pick up PATH changes in new terminals: source {rc}")
    log.success("All dependencies checked. You can now run: archon init")
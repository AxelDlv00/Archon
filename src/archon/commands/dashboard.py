"""Start the Archon web dashboard."""

from __future__ import annotations

import atexit
import os
import platform
import shutil
import signal
import socket
import subprocess
import time
import webbrowser
from importlib import resources
from pathlib import Path

import typer

from archon import log


def _data_path(sub_path: str = "") -> Path:
    root = resources.files("archon")
    if sub_path:
        return Path(str(root.joinpath(sub_path)))
    return Path(str(root))


def _has(binary: str) -> bool:
    return shutil.which(binary) is not None


def _port_in_use(port: int) -> bool:
    """Check if a TCP port is in LISTEN state."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _find_free_port(start: int, attempts: int = 10) -> int | None:
    """Find a free port starting from `start + 1`."""
    for p in range(start + 1, start + 1 + attempts):
        if not _port_in_use(p):
            return p
    return None


def _try_free_port(port: int) -> None:
    """Best-effort attempt to free a port."""
    if _has("fuser"):
        subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True)
        time.sleep(1)
    elif _has("lsof"):
        r = subprocess.run(
            ["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True, text=True,
        )
        pids = r.stdout.strip().split()
        for pid in pids:
            if pid.isdigit():
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except OSError:
                    pass
        time.sleep(1)


def _kill_old_server(pid_file: Path) -> None:
    """Stop a previously running dashboard server."""
    if not pid_file.exists():
        return
    try:
        old_pid = int(pid_file.read_text().strip())
    except (ValueError, OSError):
        pid_file.unlink(missing_ok=True)
        return

    try:
        os.kill(old_pid, 0)  # check alive
    except OSError:
        pid_file.unlink(missing_ok=True)
        return

    log.step(f"Stopping previous UI server (PID {old_pid})")
    try:
        os.kill(old_pid, signal.SIGTERM)
    except OSError:
        pass

    for _ in range(5):
        try:
            os.kill(old_pid, 0)
            time.sleep(1)
        except OSError:
            break

    pid_file.unlink(missing_ok=True)


def _check_node() -> None:
    """Verify Node.js 18+ is available, or fail with setup hint."""
    if not _has("node") or not _has("npm"):
        log.error("Node.js and npm are required for the dashboard")
        log.step("Run: archon setup")
        raise typer.Exit(1)

    r = subprocess.run(["node", "-v"], capture_output=True, text=True)
    version_str = r.stdout.strip().lstrip("v")
    try:
        major = int(version_str.split(".")[0])
    except (ValueError, IndexError):
        major = 0

    if major < 18:
        log.error(f"Node.js 18+ required (found: {version_str})")
        log.step("Run: archon setup")
        raise typer.Exit(1)

    log.success(f"Node.js v{version_str}")


def _install_if_needed(directory: Path, name: str) -> None:
    """Run npm install if node_modules is missing or stale."""
    node_modules = directory / "node_modules"
    package_json = directory / "package.json"
    lock_marker = node_modules / ".package-lock.json"

    needs_install = False
    if not node_modules.exists():
        needs_install = True
    elif package_json.exists() and lock_marker.exists():
        if package_json.stat().st_mtime > lock_marker.stat().st_mtime:
            needs_install = True

    if needs_install:
        log.step(f"Installing {name} dependencies...")
        r = subprocess.run(
            ["npm", "install", "--no-fund", "--no-audit", "--loglevel=error"],
            cwd=directory, capture_output=True, text=True,
        )
        if r.returncode != 0:
            log.error(f"Failed to install {name} dependencies: {r.stderr.strip()}")
            raise typer.Exit(1)
        log.success(f"{name} dependencies installed")


def _needs_build(client_dir: Path) -> bool:
    """Check if client needs a rebuild."""
    dist = client_dir / "dist"
    index_html = dist / "index.html"
    if not dist.exists() or not index_html.exists():
        return True

    src_dir = client_dir / "src"
    if not src_dir.exists():
        return False

    index_mtime = index_html.stat().st_mtime
    for f in src_dir.rglob("*"):
        if f.is_file() and f.stat().st_mtime > index_mtime:
            return True
    return False


def _build_client(client_dir: Path) -> None:
    """Build the client via vite."""
    vite = client_dir / "node_modules" / "vite" / "bin" / "vite.js"
    r = subprocess.run(
        ["node", str(vite), "build", "--logLevel", "warn"],
        cwd=client_dir, capture_output=True, text=True,
    )
    if r.returncode != 0:
        log.error(f"Client build failed: {r.stderr.strip()}")
        raise typer.Exit(1)
    log.success("Client built")


def _open_browser(url: str) -> None:
    """Open a URL in the default browser."""
    try:
        webbrowser.open(url)
    except Exception:
        pass


# ── main command ──────────────────────────────────────────────────────


def dashboard(
    project_path: str = typer.Argument(".", help="Path to Lean project"),
    port: int = typer.Option(8080, "--port", "-p", help="Server port."),
    dev: bool = typer.Option(False, "--dev", help="Run in dev mode (vite dev + tsx watch)."),
    build_only: bool = typer.Option(False, "--build", help="Build client only, no server."),
    open_browser: bool = typer.Option(False, "--open", help="Open browser after starting."),
) -> None:
    """Start the web dashboard for real-time monitoring.

    Shows iteration progress, parallel prover status, agent logs with
    live streaming, and proof journal milestones.
    """
    resolved = Path(project_path).resolve()
    archon_dir = resolved / ".archon"

    if not archon_dir.is_dir():
        log.error(f"No .archon/ directory found in {resolved}")
        log.step("Run: archon init first, or check the project path")
        raise typer.Exit(1)

    # Locate UI directory from package data
    ui_dir = _data_path("ui")
    if not ui_dir.exists():
        log.error("UI files not found in package data — installation may be incomplete")
        raise typer.Exit(1)

    server_dir = ui_dir / "server"
    client_dir = ui_dir / "client"
    pid_file = ui_dir / ".archon-ui.pid"

    log.key_value({
        "Project": str(resolved),
        "Port": str(port),
        "Mode": "dev" if dev else "production",
    })

    # Check Node.js (should already be installed via archon setup)
    _check_node()

    # Install npm dependencies
    _install_if_needed(server_dir, "server")
    _install_if_needed(client_dir, "client")

    # Build client (skip in dev mode)
    if not dev:
        if _needs_build(client_dir):
            log.step("Building client...")
            _build_client(client_dir)
        else:
            log.success("Client up to date")

    if build_only:
        log.success("Build complete")
        return

    # Port handling
    if _port_in_use(port):
        log.warn(f"Port {port} is already in use")
        free_port = _find_free_port(port)
        if free_port:
            port = free_port
            log.panel(f"Port changed! Using [bold]{port}[/bold] instead", style="yellow")
        else:
            log.error(f"Could not find a free port in range {port + 1}–{port + 11}")
            raise typer.Exit(1)

    # Kill old server
    _kill_old_server(pid_file)

    # Post-cleanup: if port still occupied, try to free it
    if _port_in_use(port):
        log.warn(f"Port {port} still occupied — attempting to free")
        _try_free_port(port)
        if _port_in_use(port):
            log.error(f"Port {port} still in use — free it manually")
            raise typer.Exit(1)
        log.success(f"Port {port} freed")

    # Start server
    server_cmd = [
        "node", "--import", "tsx",
        "src/index.ts", "--project", str(resolved), "--port", str(port),
    ]

    if dev:
        log.header("Dev Mode")
        log.key_value({
            "Dashboard": f"http://localhost:{port}",
            "Vite dev": "http://localhost:5173",
        })
        log.info("Press Ctrl+C to stop\n")

        server_proc = subprocess.Popen(server_cmd, cwd=server_dir)
        pid_file.write_text(str(server_proc.pid))

        def _cleanup_dev():
            server_proc.terminate()
            pid_file.unlink(missing_ok=True)
        atexit.register(_cleanup_dev)

        vite = client_dir / "node_modules" / "vite" / "bin" / "vite.js"
        try:
            subprocess.run(
                ["node", str(vite), "--port", "5173"],
                cwd=client_dir,
            )
        except KeyboardInterrupt:
            pass
        finally:
            _cleanup_dev()
        return

    # Production mode
    server_proc = subprocess.Popen(
        server_cmd, cwd=server_dir,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    pid_file.write_text(str(server_proc.pid))

    # Wait a moment to see if it crashes
    time.sleep(1)
    if server_proc.poll() is not None:
        stderr = server_proc.stderr.read().decode() if server_proc.stderr else ""
        log.error(f"Server failed to start: {stderr.strip()}")
        pid_file.unlink(missing_ok=True)
        raise typer.Exit(1)

    base_url = f"http://localhost:{port}"
    log.header("Archon Dashboard")
    log.key_value({
        "Dashboard": base_url,
        "Logs": f"{base_url}/logs",
        "Journal": f"{base_url}/journal",
        "Project": str(resolved),
        "PID": str(server_proc.pid),
    })
    log.step(f"Stop:  kill {server_proc.pid}")

    if open_browser:
        _open_browser(base_url)

    # Wait for server (Ctrl+C to stop)
    def _cleanup_prod():
        server_proc.terminate()
        pid_file.unlink(missing_ok=True)
        log.info("Dashboard stopped")

    atexit.register(_cleanup_prod)

    try:
        server_proc.wait()
    except KeyboardInterrupt:
        _cleanup_prod()
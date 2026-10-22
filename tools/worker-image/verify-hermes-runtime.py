#!/usr/bin/env python3
"""Verify the pinned Hermes dependency environment without contacting a model."""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path("/opt/hermes/hermes-agent").resolve()
RUNTIME_HOME = Path("/tmp/.hermes")
INSTALL_ROOT = Path("/opt/hermes/installs")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"Hermes runtime verification failed: {message}")


def main() -> None:
    home_value = os.environ.get("HERMES_HOME", "")
    require(
        bool(home_value) and Path(home_value).is_absolute(),
        "HERMES_HOME must be set to an absolute path",
    )
    active_home = Path(home_value).resolve()
    require(PROJECT_ROOT.is_dir(), f"Hermes source tree is missing: {PROJECT_ROOT}")

    sys.path.insert(0, str(PROJECT_ROOT))
    from pm.environments import (  # noqa: PLC0415
        activate_dependencies,
        committed_venv,
        install_state_dir,
        site_packages,
    )

    install_dir = install_state_dir(PROJECT_ROOT)
    require(install_dir.is_dir(), f"install state is missing: {install_dir}")
    facts_path = install_dir / "facts.json"
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    recorded_environment = (
        facts.get("packages", {}).get("venv", {}).get("environment")
    )
    require(isinstance(recorded_environment, str), "facts.json does not commit a venv")

    environment = Path(recorded_environment).resolve()
    environments_root = (install_dir / "environments").resolve()
    require(
        environment.is_relative_to(environments_root),
        "committed venv resolves outside this install's environments",
    )
    require((environment / "pyvenv.cfg").is_file(), "committed venv has no pyvenv.cfg")
    require(sys.version_info >= (3, 14), "verifier must use Hermes' managed Python")
    venv_python = environment / "bin" / "python"
    require(
        venv_python.is_file() and os.access(venv_python, os.X_OK),
        "committed venv interpreter is unavailable",
    )

    pm_runtime = install_dir / "pm-runtime"
    selection_path = pm_runtime / "selected.json"
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    generation_value = selection.get("generation")
    require(isinstance(generation_value, str), "PM runtime selection has no generation")
    generation = (pm_runtime / generation_value).resolve()
    require(
        generation.is_relative_to((pm_runtime / "generations").resolve()),
        "selected PM generation escapes its install",
    )
    generation_manifest = generation / "pm-runtime.json"
    require(generation_manifest.is_file(), "selected PM generation is incomplete")
    generation_data = json.loads(generation_manifest.read_text(encoding="utf-8"))
    require(
        generation_data.get("inputs") == selection.get("inputs"),
        "PM generation inputs do not match the selection",
    )

    if active_home == RUNTIME_HOME:
        runtime_store = Path(os.environ.get("HERMES_RUNTIME_DIR", "")).resolve()
        require(
            runtime_store == Path("/opt/hermes/tools").resolve(),
            "runtime must use the immutable Hermes tool store",
        )
        require((runtime_store / "facts.json").is_file(), "runtime tool-store facts are missing")
        installs_link = active_home / "installs"
        require(installs_link.is_symlink(), "runtime installs link is missing")
        require(
            installs_link.resolve() == INSTALL_ROOT.resolve(),
            "runtime installs link points outside the immutable install",
        )
        for path, target in (
            (install_dir / ".install.lock", Path("/tmp/hermes-install.lock")),
            (pm_runtime / ".prepare.lock", Path("/tmp/hermes-prepare.lock")),
            (environment.parent / ".leases", Path("/tmp/hermes-leases")),
            (generation / ".leases", Path("/tmp/hermes-leases")),
        ):
            require(path.is_symlink(), f"runtime lock/lease path is not redirected: {path.name}")
            require(path.resolve() == target.resolve(), f"runtime lock/lease path escapes /tmp: {path.name}")
            require(path.exists(), f"runtime temporary lock/lease target is missing: {target}")

    activate_dependencies(PROJECT_ROOT)
    selected_site = site_packages(environment).resolve()
    require(selected_site.is_dir(), "committed environment has no site-packages")
    require(
        selected_site in {Path(entry).resolve() for entry in sys.path if entry},
        "Hermes activation did not select the committed site-packages",
    )

    modules = (
        "pydantic",
        "openai",
        "httpx",
        "ruamel.yaml",
    )
    for module in modules:
        importlib.import_module(module)
    if active_home != RUNTIME_HOME:
        for module in (
            "hermes_cli.main",
            "run_agent",
            "model_tools",
            "toolsets",
        ):
            importlib.import_module(module)

    print(
        "Hermes runtime dependencies activated; core modules imported without model access."
    )


if __name__ == "__main__":
    main()

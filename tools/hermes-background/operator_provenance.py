"""Application-time maintained activation/completion check; no inference or lifecycle calls."""

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import sys

PIN = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-application-prep-20261113")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--fixture-source-completion", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    if (
        args.fixture_source_completion
        and source != (PIN / "bootstrap-existing-disposable/hermes-agent").resolve()
    ):
        raise ValueError(
            "Fixture mode accepts only the existing disposable rehearsal checkout"
        )
    sys.path.insert(0, str(source))
    from pm.environments import activate_dependencies, runtime_facts_path
    from hermes_cli.venv_sync import completion_pending_path

    expected = json.loads((PIN / "source-candidate.json").read_text())
    selected = json.loads(runtime_facts_path(source).read_text())["packages"]["venv"]
    if set(selected["extras"]) != {"all", "discord", "telegram", "voice"}:
        raise RuntimeError("Recorded four-extra selection changed")
    stamp = json.loads((source / "install-stamp.json").read_text())
    if stamp.get("commit") != expected["commit"] or stamp.get("dirty") is not False:
        raise RuntimeError("Current successful source-completion stamp missing")
    if (
        completion_pending_path(source).exists()
        or (source / ".update-incomplete").exists()
    ):
        raise RuntimeError("Maintained completion still owed; do not start host")
    if not args.fixture_source_completion:
        marker = json.loads(
            (source / ".hermes-bootstrap-complete").read_text(encoding="utf-8-sig")
        )
        if marker.get("pinnedCommit") != expected["commit"]:
            raise RuntimeError("Pinned bootstrap completion marker mismatch")
    activate_dependencies(source)
    modules = []
    for item in expected["files"]:
        if not item["path"].endswith(".py") or item["path"].startswith("tests/"):
            continue
        module = importlib.import_module(item["path"][:-3].replace("/", "."))
        actual = Path(module.__file__).resolve()
        if actual != (source / item["path"]).resolve():
            raise RuntimeError(
                "Loaded module origin differs from maintained checkout: " + item["path"]
            )
        if hashlib.sha256(actual.read_bytes()).hexdigest() != item["candidate_sha256"]:
            raise RuntimeError("Loaded module bytes differ: " + item["path"])
        modules.append(
            {
                "module": module.__name__,
                "file": str(actual),
                "sha256": item["candidate_sha256"],
            }
        )
    from hermes_cli.plugins_context import PluginContext

    if not hasattr(PluginContext, "notification"):
        raise RuntimeError("Canonical notification capability absent")
    print(
        json.dumps(
            {
                "modules": modules,
                "extras": selected["extras"],
                "stamp": stamp,
                "owedCompletion": False,
                "bootstrapMarkerChecked": not args.fixture_source_completion,
                "fixtureOnly": args.fixture_source_completion,
            }
        )
    )


if __name__ == "__main__":
    main()

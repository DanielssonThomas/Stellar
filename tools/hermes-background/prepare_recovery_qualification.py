"""Export the pinned pair/candidate for test-only recovery qualification; no new package."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(
    "D:/Hermes/profiles/ivy/cache/scratch/stellar-339-recovery-qualification-20261113"
)
PIN = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-application-prep-20261113")
OLD = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-timer-final-20261113")


def git(source, *args):
    return subprocess.check_output(
        [
            "git",
            "--no-optional-locks",
            "-c",
            "core.autocrlf=false",
            "-C",
            str(source),
            *args,
        ]
    )


def export(source, revision, target):
    target.mkdir()
    with tempfile.NamedTemporaryFile(dir=OUT, suffix=".tar", delete=False) as file:
        archive = Path(file.name)
    try:
        git(source, "archive", "--format=tar", "--output=" + str(archive), revision)
        with tarfile.open(archive) as stream:
            stream.extractall(target, filter="data")
    finally:
        archive.unlink()


def main():
    if OUT.exists():
        raise ValueError(
            "Fresh qualification directory required; preserve prior evidence"
        )
    config = json.loads((OLD / "composition-config.json").read_text())
    assert (
        git(OLD / "stellar", "write-tree").decode().strip()
        == "5c13a97a6dbf239ca43e8e99a289d5bf7f76fc6b"
    )
    pin = json.loads((PIN / "source-candidate.json").read_text())
    assert pin["commit"] == "6ebd6d755f607fc839f032109c5afc65ee9ab681"
    OUT.mkdir()
    export(OLD / "stellar", config["timer_tree"], OUT / "stellar")
    export(PIN / "source", pin["commit"], OUT / "runtime")
    for relative, oid in config["source_inventory"].items():
        data = (OUT / "stellar" / relative).read_bytes()
        assert (
            hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            == oid
        ), relative
    for row in pin["files"]:
        assert (
            hashlib.sha256((OUT / "runtime" / row["path"]).read_bytes()).hexdigest()
            == row["candidate_sha256"]
        )
    shutil.copytree(OLD / "stellar/dist", OUT / "stellar/dist")
    ivy = OUT / "stellar/apps/stellar-desktop/src-tauri/src/ivy"
    shutil.copyfile(
        ROOT / "tools/hermes-background/recovery_qualification_tests.rs",
        ivy / "recovery_qualification_tests.rs",
    )
    with (ivy / "mod.rs").open("a") as file:
        file.write("\n#[cfg(all(test, windows))]\nmod recovery_qualification_tests;\n")
    shutil.copyfile(
        ROOT / "tools/hermes-background/observer_composition_tests.py",
        OUT / "runtime/tests/gateway/test_observer_notification_composition.py",
    )
    shutil.copyfile(
        ROOT / "tools/hermes-background/recovery_host_tests.py",
        OUT / "runtime/tests/gateway/test_recovery_host.py",
    )
    config.update(
        {
            "source": str(OUT / "stellar"),
            "consumer_source": str(OUT / "stellar"),
            "observer_source": str(OUT / "stellar/config/hermes-plugins/stellar-herdr"),
            "runtime_candidate_commit": pin["commit"],
            "test_only_overlay": True,
        }
    )
    (OUT / "composition-config.json").write_text(json.dumps(config, indent=2) + "\n")
    print(
        json.dumps(
            {
                "out": str(OUT),
                "pinned_production_files": len(config["source_inventory"]),
                "overlay": "cfg(test) module only; no production binary/package built",
            }
        )
    )


if __name__ == "__main__":
    main()

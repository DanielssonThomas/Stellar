"""Apply one sealed consumer delta to the retained composition, in fresh scratch only."""

import hashlib
import json
from pathlib import Path
import shutil

from prepare_recovery_qualification import OLD, PIN, ROOT, export, git
import prepare_recovery_qualification as archive

OUT = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-recovery-a88ccbd-20261114")
PACKET = Path(
    "D:/ai-repositories/stellar-issue-299/artifacts/issue-299/replay-recovery-a88ccbd-20261114"
)
BASE = "e35a74683bf162411510967fe9cc0f09c942fe99"
CONSUMER = "a88ccbdbd60ddd64232a7f3185721eeba8c3d305"
PATCH = "ec7bf1e43ee72e6473ba2fa22e18254aa85fa92e194ad032d82cacbbff7554d4"
CANDIDATE = "6ebd6d755f607fc839f032109c5afc65ee9ab681"
RUNTIME_PATCH = "c0a21ab5118d6f7ab23b617e7ea2d2f81d072fa1d9fcd63ba0ba857d8d7356ce"
PIN_SHA = "ee71741a0856683a2e00d1f13849c8854137f6374efb2857a9714e2e4f3d527b"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if OUT.exists():
        raise ValueError("Fresh directory required; preserve previous evidence")
    manifest = json.loads((PACKET / "manifest.json").read_text())
    patch = (PACKET / "consumer-recovery.patch").read_bytes()
    assert manifest["base"] == BASE and manifest["checkpoint"] == CONSUMER
    assert manifest["patch"] == PATCH == sha(patch)
    assert manifest["runtimeCandidate"] == CANDIDATE
    assert manifest["runtimePatch"] == RUNTIME_PATCH
    assert sha((PIN / "source-candidate.json").read_bytes()) == PIN_SHA
    pin = json.loads((PIN / "source-candidate.json").read_text())
    assert pin["commit"] == CANDIDATE
    assert (
        git(PIN / "source", "rev-parse", CANDIDATE + "^").decode().strip()
        == "3b421578588243f920886e6fe79a6faa87ea026e"
    )
    images = manifest["images"]
    changed = git(ROOT, "diff", "--name-only", BASE, CONSUMER).decode().splitlines()
    assert set(changed) == set(images)
    for path, row in images.items():
        assert sha(git(ROOT, "show", CONSUMER + ":" + path)) == row["post"]
        if row["pre"] is not None:
            assert sha(git(ROOT, "show", BASE + ":" + path)) == row["pre"]
    config = json.loads((OLD / "composition-config.json").read_text())
    assert config["timer_tree"] == "5c13a97a6dbf239ca43e8e99a289d5bf7f76fc6b"
    OUT.mkdir()
    archive.OUT = OUT
    source = OUT / "stellar"
    export(OLD / "stellar", config["timer_tree"], source)
    for path, oid in config["source_inventory"].items():
        data = (source / path).read_bytes()
        assert (
            hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            == oid
        ), path
    for path, row in images.items():
        file = source / path
        assert (sha(file.read_bytes()) if file.exists() else None) == row["pre"], path
    (OUT / "consumer-recovery.patch").write_bytes(patch)
    git(source, "apply", "--check", str(OUT / "consumer-recovery.patch"))
    git(source, "apply", str(OUT / "consumer-recovery.patch"))
    for path, row in images.items():
        assert sha((source / path).read_bytes()) == row["post"], path
    # Check every unaffected blob too; root Cargo/lock and producer remain immutable.
    for path in config["source_inventory"]:
        if path not in images:
            data = (source / path).read_bytes()
            assert (
                hashlib.sha1(
                    b"blob " + str(len(data)).encode() + b"\0" + data
                ).hexdigest()
                == config["source_inventory"][path]
            ), path
    production = {
        p.relative_to(source).as_posix(): sha(p.read_bytes())
        for p in source.rglob("*")
        if p.is_file()
    }
    export(PIN / "source", pin["commit"], OUT / "runtime")
    for row in pin["files"]:
        assert (
            sha((OUT / "runtime" / row["path"]).read_bytes()) == row["candidate_sha256"]
        )
    shutil.copytree(OLD / "stellar/dist", source / "dist")
    for path, expected in config["renderer_unchanged"].items():
        assert (
            sha((source / "dist/apps/stellar-desktop/browser" / path).read_bytes())
            == expected
        ), path
    shutil.copyfile(
        ROOT / "tools/hermes-background/observer_composition_tests.py",
        OUT / "runtime/tests/gateway/test_observer_notification_composition.py",
    )
    shutil.copyfile(
        source / "tools/native/fixtures/recovery_host_capture.py",
        OUT / "runtime/tests/gateway/test_recovery_composition.py",
    )
    ivy = source / "apps/stellar-desktop/src-tauri/src/ivy"
    shutil.copyfile(
        ROOT / "tools/hermes-background/recovery_composition_tests.rs",
        ivy / "recovery_composition_tests.rs",
    )
    with (ivy / "mod.rs").open("ab") as file:
        file.write(b"\n#[cfg(all(test, windows))]\nmod recovery_composition_tests;\n")
    config.update(
        source=str(source),
        consumer_source=str(source),
        observer_source=str(source / "config/hermes-plugins/stellar-herdr"),
        runtime_candidate_commit=pin["commit"],
        consumer=CONSUMER,
        consumer_delta=PATCH,
        production_sha256=production,
        test_only_overlay=True,
    )
    (OUT / "composition-config.json").write_text(json.dumps(config, indent=2) + "\n")
    shutil.copyfile(PACKET / "manifest.json", OUT / "consumer-manifest.json")
    git(source, "init", "-b", "qualification/339-recovery-a88ccbd")
    git(source, "add", ".")
    print(
        json.dumps(
            {
                "out": str(OUT),
                "sealed_delta_files": len(images),
                "verified_production_files": len(production),
                "renderer_files": len(config["renderer_unchanged"]),
            }
        )
    )


if __name__ == "__main__":
    main()

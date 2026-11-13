"""Verify exact offline inputs/output and record evidence, without authorizing live work."""

import json
from pathlib import Path
import re

import external_operator as operator
from prepare_recovery_composition import CANDIDATE, CONSUMER, OUT, PATCH, ROOT, sha
from prepare_recovery_qualification import PIN, git


def verify_execution(path, output=OUT):
    record = json.loads((output / path.replace(".log", ".execution.json")).read_text())
    assert record["exitCode"] == 0, path
    assert record["logSha256"] == sha((output / path).read_bytes()), path
    assert record["runnerSha256"] == sha(
        (ROOT / "tools/hermes-background/run_recovery_composition.py").read_bytes()
    ), path
    return record


def main():
    config = json.loads((OUT / "composition-config.json").read_text())
    source = OUT / "stellar"
    runtime_pin = json.loads((PIN / "source-candidate.json").read_text())
    for row in runtime_pin["files"]:
        assert (
            sha((OUT / "runtime" / row["path"]).read_bytes()) == row["candidate_sha256"]
        )
    fixture_inputs = {
        ROOT / "tools/hermes-background/observer_composition_tests.py": OUT
        / "runtime/tests/gateway/test_observer_notification_composition.py",
        source / "tools/native/fixtures/recovery_host_capture.py": OUT
        / "runtime/tests/gateway/test_recovery_composition.py",
        ROOT / "tools/hermes-background/recovery_composition_tests.rs": source
        / "apps/stellar-desktop/src-tauri/src/ivy/recovery_composition_tests.rs",
    }
    for original, executed in fixture_inputs.items():
        assert original.read_bytes() == executed.read_bytes()
    suffix = b"\n#[cfg(all(test, windows))]\nmod recovery_composition_tests;\n"
    for path, expected in config["production_sha256"].items():
        data = (source / path).read_bytes()
        if path == "apps/stellar-desktop/src-tauri/src/ivy/mod.rs":
            assert data.endswith(suffix)
            data = data[: -len(suffix)]
        assert sha(data) == expected, path
    for path, expected in config["renderer_unchanged"].items():
        assert (
            sha((source / "dist/apps/stellar-desktop/browser" / path).read_bytes())
            == expected
        )
    binary = operator.BINARY.read_bytes()
    assert sha(binary) == operator.EXE_SHA
    assert binary == (ROOT / "target/debug/stellar-desktop.exe").read_bytes()
    ivy = source / "apps/stellar-desktop/src-tauri/src/ivy"
    process = (ivy / "process.rs").read_text()
    embedded = re.findall(r'include_str!\("([^"]+\.py)"\)', process)
    assert {"ivy_recovery.py", "ivy_recovery_store.py", "ivy_reconcile.py"} <= set(
        embedded
    )
    for name in embedded:
        assert (ivy / name).read_bytes() in binary, name
    metadata = json.loads((OUT / "operator-metadata.json").read_text())
    assert metadata["independent"] and metadata["ordinaryToken"]
    assert metadata["session"] == operator.SESSION
    assert metadata["gateway"]["profiles"] == operator.PROFILES
    assert metadata["liveActions"] is False
    checks = {
        "host-recovery.log": "14 tests passed, 0 failed",
        "consumer-python.log": "Ran 100 tests",
        "native-replay_recovery.log": "11 passed; 0 failed",
        "native-recovery_composition_tests.log": "3 passed; 0 failed",
        "native-clippy.log": "Finished `dev` profile",
        "native-clippy-smoke.log": "Finished `dev` profile",
        "native-build.log": "Finished `dev` profile",
        "operator-tests.log": "Ran 7 tests",
        "seal-tests.log": "Ran 3 tests",
        "provenance-fixture.log": '"fixtureOnly": true',
    }
    for path, marker in checks.items():
        assert marker in (OUT / path).read_text(errors="replace"), path
    required = set(checks) | {
        "native-format.log",
        "native-size.log",
        "native-bindings.log",
        "operator-plan.log",
    }
    for path in required:
        verify_execution(path)
    assert not (OUT / "native-format.log").read_bytes()
    assert "Error:" not in (OUT / "native-size.log").read_text()
    assert (OUT / "native-bindings.log").exists()
    producer = "a0eea43eea9f3b9c33f0678ce9762b2c80000335"
    postimages = {
        p.name: sha(
            git(
                ROOT,
                "show",
                producer + ":config/hermes-plugins/stellar-herdr/" + p.name,
            )
        )
        for p in (source / "config/hermes-plugins/stellar-herdr").iterdir()
        if p.is_file()
    }
    assert postimages == metadata["producerPostimages"]
    logs = sorted(OUT.glob("*.log"))
    output = {
        "status": "OFFLINE_CHECKS_PASS_REVIEW_PENDING",
        "candidate": CANDIDATE,
        "consumer": CONSUMER,
        "consumerDelta": PATCH,
        "producer": producer,
        "compositionTree": git(source, "write-tree").decode().strip(),
        "productionFiles": len(config["production_sha256"]),
        "rendererFiles": len(config["renderer_unchanged"]),
        "embeddedPythonModules": embedded,
        "desktopPath": str(operator.BINARY),
        "desktopSha256": operator.EXE_SHA,
        "desktopBytes": len(binary),
        "operatorSha256": operator.digest(Path(operator.__file__)),
        "helperHashes": {
            str(p): operator.digest(p) for p in operator.protected_inputs()
        },
        "producerPostimages": postimages,
        "executedFixtureHashes": {
            str(executed): sha(executed.read_bytes())
            for executed in fixture_inputs.values()
        },
        "runtimePostimages": runtime_pin["files"],
        "executionRecords": {
            path: json.loads(
                (OUT / path.replace(".log", ".execution.json")).read_text()
            )
            for path in sorted(required)
        },
        "sourceAndEvidence": {
            str(p.relative_to(OUT)): sha(p.read_bytes())
            for p in logs
            + [
                OUT / "composition-config.json",
                OUT / "consumer-manifest.json",
                OUT / "consumer-recovery-retained.json",
                OUT / "consumer-recovery-missed.json",
                OUT / "captured-host-frames.json",
                OUT / "operator-metadata.json",
            ]
        },
        "rootSourceHashes": {
            str(p.relative_to(ROOT)): sha(p.read_bytes())
            for p in [
                *(ROOT / "tools/hermes-background").glob("*recovery_composition*"),
                ROOT / "tools/hermes-background/observer_composition_tests.py",
                ROOT / "tools/hermes-background/external_operator.py",
                ROOT / "tools/hermes-background/operator_provenance.py",
            ]
            if p.is_file()
        },
        "liveEnabled": False,
        "actualUnknown299Touched": False,
        "oldHostCoverage": "Current candidate recovery with inspect-unavailable transport fixture proves suppression/custody; no full original3b-host live recovery claimed",
        "nativeSmoke": "Not run: genuine GUI/audio/live actions remain behind later maintenance handoff",
    }
    (OUT / "QUALIFICATION.json").write_text(json.dumps(output, indent=2) + "\n")
    print(
        json.dumps(
            {
                "qualificationSha256": sha((OUT / "QUALIFICATION.json").read_bytes()),
                "desktopSha256": operator.EXE_SHA,
                "embeddedModules": len(embedded),
                "productionFiles": output["productionFiles"],
            }
        )
    )


if __name__ == "__main__":
    main()

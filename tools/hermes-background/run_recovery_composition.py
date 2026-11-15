"""Execute isolated source checks; never starts a gateway, GUI, model or live worker."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import shutil

from prepare_recovery_composition import OUT, ROOT

PYTHON = Path(
    "D:/Hermes/profiles/ivy/cache/scratch/stellar-339-plugin-notification-candidate-20261113/test-env/Scripts/python.exe"
)
TOOLCHAIN = Path("D:/stellar-temp/stellar-249-toolchain")


def run(name, command, cwd, env):
    log_path = OUT / (name + ".log")
    record_path = OUT / (name + ".execution.json")
    if log_path.exists():
        from prepare_recovery_composition import sha

        previous = OUT / (name + ".previous-" + sha(log_path.read_bytes()) + ".log")
        if not previous.exists():
            shutil.copyfile(log_path, previous)
        if record_path.exists():
            shutil.copyfile(record_path, previous.with_suffix(".execution.json"))
    with log_path.open("wb") as log:
        result = subprocess.run(
            command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT
        )
    from prepare_recovery_composition import sha

    record_path.write_text(
        json.dumps(
            {
                "command": command,
                "cwd": str(cwd),
                "exitCode": result.returncode,
                "logSha256": sha(log_path.read_bytes()),
                "runnerSha256": sha(Path(__file__).read_bytes()),
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"check": name, "exit": result.returncode}), flush=True)
    result.check_returncode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices=[
            "host",
            "consumer",
            "native",
            "native-tail",
            "bindings",
            "build",
            "operator",
        ],
    )
    args = parser.parse_args()
    env = os.environ.copy()
    env["PATH"] = str(PYTHON.parent) + os.pathsep + env["PATH"]
    for key in [
        "__HERMES_ACTIVATED",
        "__HERMES_TEST_PYTHON",
        "MSYS_NO_PATHCONV",
        "MSYS2_ARG_CONV_EXCL",
    ]:
        env.pop(key, None)
    source = OUT / "stellar"
    if args.mode in {"host", "consumer"}:
        home = OUT / "test-home"
        home.mkdir(exist_ok=True)
        for key in ["HERMES_HOME", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]:
            env[key] = str(home)
        env.update(HERMES_PYTHON=PYTHON.as_posix(), HERMES_CONFIG_BACKEND="file")
        if args.mode == "host":
            run(
                "host-recovery",
                [
                    "D:/Hermes/tools/git-2.53.0+3-win32-x64/bin/bash.exe",
                    "scripts/run_tests.sh",
                    "tests/gateway/test_recovery_composition.py",
                    "tests/gateway/test_observer_notification_composition.py",
                    "-q",
                ],
                OUT / "runtime",
                env,
            )
        run(
            "consumer-python",
            [
                str(PYTHON),
                "-m",
                "unittest",
                "tools.native.ivy_bridge_test",
                "tools.native.ivy_approvals_test",
                "tools.native.ivy_recovery_test",
                "tools.native.ivy_ordinary_completion_test",
                "tools.native.ivy_plugin_notification_test",
                "tools.native.ivy_reconcile_test",
            ],
            source,
            env,
        )
        return
    if args.mode == "operator":
        run(
            "operator-tests",
            [
                str(PYTHON),
                str(ROOT / "tools/hermes-background/external_operator_tests.py"),
            ],
            ROOT,
            env,
        )
        fixture_env = dict(env)
        disposable = (
            OUT.parent / "stellar-339-application-prep-20261113/completion-disposable"
        )
        fixture_env.update(
            HERMES_HOME=str(disposable / "hermes"),
            HERMES_RUNTIME_DIR=str(disposable / "tools"),
            HOME=str(disposable / "home"),
            USERPROFILE=str(disposable / "home"),
            LOCALAPPDATA=str(disposable / "home/AppData/Local"),
            APPDATA=str(disposable / "home/AppData/Roaming"),
            TEMP=str(OUT / "native-temp"),
            TMP=str(OUT / "native-temp"),
        )
        run(
            "provenance-fixture",
            [
                str(PYTHON),
                "-I",
                "-B",
                str(ROOT / "tools/hermes-background/operator_provenance.py"),
                "--source",
                "D:/Hermes/profiles/ivy/cache/scratch/stellar-339-application-prep-20261113/bootstrap-existing-disposable/hermes-agent",
                "--fixture-source-completion",
            ],
            ROOT,
            fixture_env,
        )
        run(
            "operator-plan",
            [
                str(PYTHON),
                "-I",
                "-B",
                str(ROOT / "tools/hermes-background/external_operator.py"),
                "plan",
            ],
            ROOT,
            env,
        )
        return
    temp = OUT / "native-temp"
    temp.mkdir(exist_ok=True)
    env.update(
        CARGO_HOME=str(TOOLCHAIN / "cargo"),
        RUSTUP_HOME=str(TOOLCHAIN / "rustup"),
        CARGO_TARGET_DIR=str(ROOT / "target"),
        CARGO_NET_OFFLINE="true",
        TEMP=str(temp),
        TMP=str(temp),
        STELLAR_RECOVERY_COMPOSITION=str(OUT),
    )
    env["PATH"] = str(TOOLCHAIN / "cargo/bin") + os.pathsep + env["PATH"]
    cargo = str(TOOLCHAIN / "cargo/bin/cargo.exe")
    if args.mode in {"native", "native-tail", "bindings"}:
        dependency = source / "node_modules/typescript"
        if not dependency.exists():
            shutil.copytree(
                ROOT / "node_modules/typescript",
                dependency,
                ignore=shutil.ignore_patterns("node_modules"),
            )
    if args.mode == "bindings":
        run(
            "native-bindings",
            ["node", "tools/native/cargo.mjs", "contract-check"],
            source,
            env,
        )
        return
    if args.mode == "build":
        run(
            "native-build",
            [
                cargo,
                "build",
                "--offline",
                "--locked",
                "-p",
                "stellar-desktop",
                "--features",
                "custom-protocol",
            ],
            source,
            env,
        )
        return
    if args.mode == "native":
        run("native-format", [cargo, "fmt", "--all", "--", "--check"], source, env)
    for name in (
        ["replay_recovery", "recovery_composition_tests"]
        if args.mode == "native"
        else ["recovery_composition_tests"]
    ):
        run(
            "native-" + name,
            [
                cargo,
                "test",
                "--offline",
                "--locked",
                "-p",
                "stellar-desktop",
                "--bin",
                "stellar-desktop",
                "ivy::" + name,
            ],
            source,
            env,
        )
    if args.mode == "native":
        run(
            "native-clippy",
            [
                cargo,
                "clippy",
                "--offline",
                "--locked",
                "--workspace",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ],
            source,
            env,
        )
        run(
            "native-clippy-smoke",
            [
                cargo,
                "clippy",
                "--offline",
                "--locked",
                "-p",
                "stellar-desktop",
                "--features",
                "native-smoke",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ],
            source,
            env,
        )
    run(
        "native-size",
        [
            cargo,
            "run",
            "--offline",
            "--locked",
            "--quiet",
            "-p",
            "stellar-rust-size",
            "--",
            str(source),
        ],
        source,
        env,
    )
    run(
        "native-bindings",
        ["node", "tools/native/cargo.mjs", "contract-check"],
        source,
        env,
    )


if __name__ == "__main__":
    main()

"""Prepare the sealed UI-only consumer delta; no live/runtime/application operations."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import prepare_recovery_qualification as archive

ROOT = Path(__file__).resolve().parents[2]
OLD = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-recovery-a88ccbd-20261114")
OUT = Path(
    "D:/Hermes/profiles/ivy/cache/scratch/stellar-339-t22-diagnostics-3333b18-20261114"
)
PACKET = Path(
    "D:/ai-repositories/stellar-issue-299/artifacts/issue-299/t22-delivery-3333b18-20261114"
)
BASE = "a88ccbdbd60ddd64232a7f3185721eeba8c3d305"
CONSUMER = "3333b1804e1790a52d925605b082fc59c8390d93"
TREE = "cbc1abc2a14734a563089519cab4fcd8f2291121"
PATCH = "eaa3e307f5283e360645eafe91dee143d422012e7ac107c06fdeee0e826efac2"
NODE = "C:/Program Files/nodejs/node.exe"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(cwd, *args):
    return archive.git(cwd, *args)


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def inventory(source, tree):
    return {
        path.decode(): head.decode().split()[2]
        for row in git(source, "ls-tree", "-rz", tree).split(b"\0")
        if row
        for head, path in [row.split(b"\t", 1)]
    }


def verify_source(config):
    for relative, oid in config["sourceInventory"].items():
        assert blob((OUT / "stellar" / relative).read_bytes()) == oid, relative


def prepare():
    assert not OUT.exists(), "Fresh output required; preserve prior evidence"
    manifest = json.loads((PACKET / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["base"] == BASE and manifest["checkpoint"] == CONSUMER
    patch = (PACKET / "consumer-diagnostics.patch").read_bytes()
    assert manifest["patchSha256"] == PATCH == sha(patch)
    images = manifest["images"]
    changed = git(ROOT, "diff", "--name-only", BASE, CONSUMER).decode().splitlines()
    assert set(changed) == set(images) and len(images) == 14
    assert all(
        not p.endswith((".rs", "Cargo.toml", "Cargo.lock", "generated.ts"))
        for p in changed
    )
    for path, row in images.items():
        assert sha(git(ROOT, "show", BASE + ":" + path)) == row["pre"], path
        assert sha(git(ROOT, "show", CONSUMER + ":" + path)) == row["post"], path
    for name, digest in manifest["evidence"].items():
        assert sha((PACKET / name).read_bytes()) == digest, name
    assert git(OLD / "stellar", "write-tree").decode().strip() == TREE
    expected = inventory(OLD / "stellar", TREE)
    OUT.mkdir()
    archive.OUT = OUT
    source = OUT / "stellar"
    archive.export(OLD / "stellar", TREE, source)
    for path, oid in expected.items():
        assert blob((source / path).read_bytes()) == oid, path
    for path, row in images.items():
        assert sha((source / path).read_bytes()) == row["pre"], path
    (OUT / "consumer-diagnostics.patch").write_bytes(patch)
    git(source, "init", "-b", "qualification/339-t22-diagnostics")
    git(source, "apply", "--check", str(OUT / "consumer-diagnostics.patch"))
    git(source, "apply", str(OUT / "consumer-diagnostics.patch"))
    for path, row in images.items():
        assert sha((source / path).read_bytes()) == row["post"], path
        expected[path] = blob((source / path).read_bytes())
    config = {
        "producer": "a0eea43eea9f3b9c33f0678ce9762b2c80000335",
        "baseConsumer": BASE,
        "consumer": CONSUMER,
        "baseTree": TREE,
        "patch": PATCH,
        "runtime": "6ebd6d755f607fc839f032109c5afc65ee9ab681",
        "sourceInventory": expected,
        "live": False,
    }
    verify_source(config)
    git(source, "add", ".")
    config["tree"] = git(source, "write-tree").decode().strip()
    (OUT / "composition.json").write_text(json.dumps(config, indent=2) + "\n")
    shutil.copyfile(PACKET / "manifest.json", OUT / "consumer-manifest.json")
    # Reuse the existing locked build dependencies, with private Nx/cache/output directories.
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            f"New-Item -ItemType Junction -Path '{source / 'node_modules'}' -Target '{ROOT / 'node_modules'}' | Out-Null",
        ],
        check=True,
    )
    print(
        json.dumps(
            {
                "out": str(OUT),
                "files": len(expected),
                "deltaFiles": len(images),
                "tree": config["tree"],
            }
        )
    )


def run(name, args, env):
    log = OUT / (name + ".log")
    assert not log.exists(), "Preserve a failed/prior command log before rerun"
    with log.open("wb") as stream:
        result = subprocess.run(
            args, cwd=OUT / "stellar", env=env, stdout=stream, stderr=subprocess.STDOUT
        )
    record = {
        "command": args,
        "cwd": str(OUT / "stellar"),
        "exitCode": result.returncode,
        "logSha256": sha(log.read_bytes()),
        "driverSha256": sha(Path(__file__).read_bytes()),
    }
    (OUT / (name + ".execution.json")).write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"check": name, "exit": result.returncode}), flush=True)
    result.check_returncode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "checks", "renderer", "native"])
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare()
        return
    config = json.loads((OUT / "composition.json").read_text())
    verify_source(config)
    env = os.environ.copy()
    for key in ["MSYS_NO_PATHCONV", "MSYS2_ARG_CONV_EXCL"]:
        env.pop(key, None)
    env.update(
        NX_DAEMON="false",
        NX_WORKSPACE_DATA_DIRECTORY=str(OUT / "nx-data"),
        NX_CACHE_DIRECTORY=str(OUT / "nx-cache"),
        CI="true",
    )
    nx = [NODE, str(ROOT / "node_modules/nx/bin/nx.js")]
    if args.mode == "checks":
        selections = {
            "service-desktop-adapter": [
                "src/lib/speech/update-voice-cue.spec.ts",
                "src/lib/services/ivy-adapter.service.spec.ts",
            ],
            "ui-molecules": ["src/lib/molecules/fault-log-molecule.component.spec.ts"],
            "stellar-desktop": [
                "src/app/app.component.spec.ts",
                "src/app/desktop-faults.spec.ts",
                "src/app/desktop-voice.spec.ts",
            ],
        }
        for project, includes in selections.items():
            selection = (
                []
                if project == "ui-molecules"
                else [
                    "--watch=false",
                    *["--include=**/" + Path(path).name for path in includes],
                ]
            )
            run(
                "focused-" + project,
                [
                    *nx,
                    "run",
                    project + ":test",
                    "--skip-nx-cache",
                    *selection,
                ],
                env,
            )
        run(
            "affected-lint",
            [
                *nx,
                "run-many",
                "-t",
                "lint",
                "-p",
                "service-desktop-adapter,ui-molecules,stellar-desktop",
                "--skip-nx-cache",
                "--parallel=2",
            ],
            env,
        )
    elif args.mode == "renderer":
        run(
            "renderer-build",
            [
                *nx,
                "run-many",
                "-t",
                "build",
                "-p",
                "service-desktop-adapter,stellar-desktop",
                "--configuration=production",
                "--parallel=2",
            ],
            env,
        )
        dist = OUT / "stellar/dist/apps/stellar-desktop/browser"
        assets = {
            p.relative_to(dist).as_posix(): sha(p.read_bytes())
            for p in dist.rglob("*")
            if p.is_file()
        }
        assert "index.html" in assets
        (OUT / "renderer-assets.json").write_text(json.dumps(assets, indent=2) + "\n")
    elif args.mode == "native":
        toolchain = Path("D:/stellar-temp/stellar-249-toolchain")
        temp = OUT / "native-temp"
        temp.mkdir(exist_ok=True)
        env.update(
            CARGO_HOME=str(toolchain / "cargo"),
            RUSTUP_HOME=str(toolchain / "rustup"),
            CARGO_TARGET_DIR=str(ROOT / "target"),
            CARGO_NET_OFFLINE="true",
            TEMP=str(temp),
            TMP=str(temp),
        )
        env["PATH"] = str(toolchain / "cargo/bin") + os.pathsep + env["PATH"]
        run(
            "native-build",
            [
                str(toolchain / "cargo/bin/cargo.exe"),
                "build",
                "--offline",
                "--locked",
                "-p",
                "stellar-desktop",
                "--features",
                "custom-protocol",
            ],
            env,
        )
        portable = OUT / "portable"
        portable.mkdir()
        binary = portable / "stellar-desktop-a0eea43-3333b18.exe"
        shutil.copyfile(ROOT / "target/debug/stellar-desktop.exe", binary)
        (OUT / "binary.json").write_text(
            json.dumps(
                {
                    "path": str(binary),
                    "sha256": sha(binary.read_bytes()),
                    "bytes": binary.stat().st_size,
                    "launched": False,
                },
                indent=2,
            )
            + "\n"
        )
        run(
            "embedded-renderer",
            [
                NODE,
                str(ROOT / "tools/hermes-background/verify_embedded_renderer.mjs"),
                str(OUT),
                str(ROOT / "target/debug/stellar-desktop.d"),
            ],
            env,
        )
    verify_source(config)


if __name__ == "__main__":
    main()

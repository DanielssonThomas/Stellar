"""Explicitly provision Ivy's optional offline Windows speech-expression engine."""

import argparse
import os
from pathlib import Path
import platform
import runpy
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import venv


HERE = Path(__file__).resolve().parent
WORKER = HERE.parent.parent / "apps/stellar-desktop/src-tauri/src/speech/expression_worker.py"
ROOT = Path(os.environ.get("LOCALAPPDATA", "")) / "Stellar" / "IvyExpression"
LARGE_MODEL = "emotion2vec_plus_large"
BASE_MODEL = "emotion2vec_plus_base"
LARGE_REVISION = "6c303ba987b86b93193de93e34bb2b077a6bedc4"
BASE_REVISIONS = {
    "config.yaml": "58354f1e5b6c118cf8b175b5b1955d6b07df42c2",
    "configuration.json": "58354f1e5b6c118cf8b175b5b1955d6b07df42c2",
    "tokens.txt": "97b6c3aeb9878641d4721675edd605e1577d0b5d",
    "model.pt": "58354f1e5b6c118cf8b175b5b1955d6b07df42c2",
}
BASE_ASSETS = {
    "config.yaml": "50674ec187406b4f1208925594ceaf1f28f16a22333b5f2ac5b3d0cbffdd670e",
    "configuration.json": "8b6a745213025c7d4565f9f074cfef1b5cd5ef76e38e2a8f7f8a3db271e735b2",
    "tokens.txt": "654625c18ef0f0583441a3b811c20904f2cf30febb716f32e14810b8e6bb715c",
    "model.pt": "60710b5aae1dbe69bdac8920028fb05882d4314fd09031922b4b61ee9e7aadbd",
}
EXAMPLE_DIGEST = "a4839eaaa3d54bd2db6eb48aa3d40def1b5c5004df3fd163a8dcd045097f8a23"


def download(url, destination, digest, verified):
    if verified(destination, digest):
        return
    print(f"Downloading {destination.parent.name}/{destination.name}", flush=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staged = Path(temporary) / destination.name
        with urllib.request.urlopen(url, timeout=120) as response, staged.open("wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)
        if not verified(staged, digest):
            raise ValueError(f"Official model asset checksum mismatch: {destination.name}")
        staged.replace(destination)


def large_url(name):
    return f"https://huggingface.co/emotion2vec/{LARGE_MODEL}/resolve/{LARGE_REVISION}/{name}?download=true"


def provision_assets(args):
    worker = runpy.run_path(str(WORKER))
    verified = worker["verified"]
    for name, digest in worker["ASSETS"].items():
        download(large_url(name), ROOT / LARGE_MODEL / name, digest, verified)
    if args.benchmark_assets or args.compare_base:
        name = "example/test.wav"
        download(large_url(name), ROOT / LARGE_MODEL / name, EXAMPLE_DIGEST, verified)
    if args.compare_base:
        for name, digest in BASE_ASSETS.items():
            revision = BASE_REVISIONS[name]
            url = f"https://modelscope.cn/models/iic/{BASE_MODEL}/resolve/{revision}/{name}"
            download(url, ROOT / BASE_MODEL / name, digest, verified)


def provision_dependencies(wheelhouse):
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    if not python.is_file():
        venv.create(ROOT / ".venv", with_pip=True)
    command = [
        str(python), "-I", "-m", "pip", "install", "--disable-pip-version-check",
        "--require-hashes", "--no-deps",
    ]
    if wheelhouse:
        command.extend(["--no-index", "--find-links", str(wheelhouse.resolve())])
    else:
        command.extend(["--index-url", "https://pypi.org/simple"])
    subprocess.run(
        [*command, "--only-binary=:all:", "-r", str(HERE / "requirements-expression-build.lock")],
        check=True,
    )
    if not wheelhouse:
        command.extend(["--extra-index-url", "https://download.pytorch.org/whl/cpu"])
    subprocess.run(
        [*command, "--no-build-isolation", "-r", str(HERE / "requirements-expression.lock")],
        check=True,
    )
    subprocess.run(
        [str(python), "-I", "-c", "from funasr.models.emotion2vec.model import Emotion2vec"],
        stdout=subprocess.DEVNULL,
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", required=True)
    parser.add_argument("--benchmark-assets", action="store_true", help="download the official demo WAV")
    parser.add_argument("--compare-base", action="store_true", help="also cache Base for benchmarks only")
    parser.add_argument("--wheelhouse", type=Path, help="use already downloaded locked Python packages")
    args = parser.parse_args()
    if (sys.platform != "win32" or sys.version_info[:2] != (3, 12)
            or platform.machine().lower() not in {"amd64", "x86_64"}
            or not ROOT.is_absolute()):
        parser.error("Use 64-bit Python 3.12 on Windows with LOCALAPPDATA configured.")
    provision_dependencies(args.wheelhouse)
    provision_assets(args)
    print(f"Verified optional CPU expression assets are ready at {ROOT}.")


if __name__ == "__main__":
    main()

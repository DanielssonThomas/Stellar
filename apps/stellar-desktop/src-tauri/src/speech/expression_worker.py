"""Classify authorized, finalized speech locally with emotion2vec+ Large."""

import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sys

RATE = 16000
MIN_SAMPLES = RATE
MAX_SAMPLES = RATE * 20
MAX_FRAME = 3 * 1024 * 1024
CPU_THREADS = min(6, max(1, (os.cpu_count() or 2) // 4))
ASSETS = {
    "config.yaml": "f4fa0eb82cc78bfebb43c56d68791afb01788085a18897d20999af7bc45d51d3",
    "configuration.json": "8b6a745213025c7d4565f9f074cfef1b5cd5ef76e38e2a8f7f8a3db271e735b2",
    "tokens.txt": "866121e470057b847d7a50e9923509141fb2924392f53385a186482a1ec0fb7f",
    "model.pt": "be501a01f26fcdc7663a062dff86af839afbaef7c4de32f5e42d7e1ad2784da4",
}
LABELS = (
    "angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised", "<unk>"
)
ABSTAIN = {"other", "<unk>"}


def verified(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == expected


def bounded_pcm(request):
    if (type(request) is not dict or set(request) != {"pcm", "sample_rate_hz"}
            or type(request["sample_rate_hz"]) is not int or request["sample_rate_hz"] != RATE):
        return None
    pcm = request["pcm"]
    if (type(pcm) is not list or not MIN_SAMPLES <= len(pcm) <= MAX_SAMPLES
            or any(type(sample) is not int or not -32768 <= sample <= 32767 for sample in pcm)):
        return None
    if not any(abs(sample) >= 164 for sample in pcm):
        return None
    return pcm


def summarize(result):
    labels = result.get("labels")
    scores = result.get("scores")
    if (type(labels) is not list or type(scores) is not list or len(scores) != len(LABELS)
            or any(type(label) is not str for label in labels)
            or tuple(label.rsplit("/", 1)[-1] for label in labels) != LABELS
            or any(type(score) not in (int, float) or not math.isfinite(score)
                   or not 0 <= score <= 1 for score in scores)
            or not math.isclose(sum(scores), 1.0, abs_tol=0.001)):
        return None

    ranked = sorted(zip(scores, LABELS), reverse=True)
    (primary_score, primary), (secondary_score, secondary) = ranked[:2]
    margin = primary_score - secondary_score
    if primary in ABSTAIN or primary_score < 0.45 or margin < 0.10:
        return None

    confidence = "high" if primary_score >= 0.70 and margin >= 0.25 else "moderate"
    expression = {"primary": primary, "confidence": confidence}
    if secondary not in ABSTAIN and secondary_score >= 0.15:
        expression["secondary"] = secondary
    return expression


def configure_offline_cpu():
    sys.dont_write_bytecode = True
    os.environ.update({
        "CUDA_VISIBLE_DEVICES": "",
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "OMP_NUM_THREADS": str(CPU_THREADS),
        "MKL_NUM_THREADS": str(CPU_THREADS),
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1",
    })


class ExpressionModel:
    def __init__(self, folder):
        if not all(verified(folder / name, digest) for name, digest in ASSETS.items()):
            raise ValueError("Expression assets missing or changed")
        configure_offline_cpu()
        import torch
        from funasr import AutoModel

        torch.set_num_interop_threads(1)
        self.model = AutoModel(
            model=str(folder), model_path=str(folder), device="cpu", ncpu=CPU_THREADS,
            disable_update=True, disable_pbar=True, trust_remote_code=False,
            ignore_init_mismatch=False,
        )

    def run(self, pcm):
        import numpy as np

        audio = np.asarray(pcm, dtype=np.float32) / np.float32(32768)
        result = self.model.generate(
            input=audio, fs=RATE, granularity="utterance", extract_embedding=False,
            disable_pbar=True,
        )
        if type(result) is not list or len(result) != 1 or type(result[0]) is not dict:
            return None
        return summarize(result[0])


def parse_request(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate request key")
            result[key] = value
        return result

    return bounded_pcm(json.loads(raw, object_pairs_hook=unique))


def serve(folder, protocol):
    model = None
    attempted = False
    while raw := sys.stdin.buffer.readline(MAX_FRAME + 1):
        if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
            return
        expression = None
        try:
            pcm = parse_request(raw)
            if pcm is not None:
                if not attempted:
                    attempted = True
                    model = ExpressionModel(folder)
                if model is not None:
                    expression = model.run(pcm)
        except Exception:
            # Enrichment is optional. Keep the request stream usable after an upstream failure.
            pass
        response = json.dumps({"expression": expression}, separators=(",", ":"))
        protocol.write((response + "\n").encode("utf-8"))
        protocol.flush()


def main():
    if len(sys.argv) != 2:
        return
    folder = Path(sys.argv[1]).resolve()
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with contextlib.redirect_stdout(sys.stderr):
            serve(folder, protocol)


if __name__ == "__main__":
    main()

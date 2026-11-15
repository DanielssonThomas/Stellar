"""Benchmark the offline expression worker on existing 16 kHz mono PCM WAVs."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
from queue import Empty, Queue
import runpy
import statistics
import struct
import subprocess
import sys
from threading import Event, Thread
import time
import wave

import psutil


HERE = Path(__file__).resolve().parent
SETUP = runpy.run_path(str(HERE / "setup-expression.py"))
WORKER = SETUP["WORKER"]
ROOT = SETUP["ROOT"]
RATE = 16000
BENCHMARK_ADAPTER = """
import json, runpy, sys
namespace = runpy.run_path(sys.argv[1])
settings = namespace["serve"].__globals__
if sys.argv[2]:
    settings["ASSETS"] = json.loads(sys.argv[2])
if sys.argv[3]:
    settings["CPU_THREADS"] = int(sys.argv[3])
sys.argv = [sys.argv[1], sys.argv[4]]
namespace["main"]()
"""
PARAKEET_PYTHON = Path("D:/Hermes/profiles/ivy/recognition/.venv/Scripts/python.exe")
PARAKEET_WORKER = WORKER.with_name("recognition_worker.py")
ENRICHMENT_DEADLINE_MS = 1250
OPTIONAL_WAIT_MS = 75


def audio_request(wav):
    with wave.open(str(wav), "rb") as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) != (1, 2, RATE):
            raise ValueError(f"Expected 16 kHz mono signed 16-bit PCM: {wav.name}")
        count = stream.getnframes()
        if not RATE <= count <= 20 * RATE:
            raise ValueError(f"Expected one to twenty seconds of audio: {wav.name}")
        pcm = struct.unpack(f"<{count}h", stream.readframes(count))
    payload = json.dumps({"pcm": pcm, "sample_rate_hz": RATE}, separators=(",", ":"))
    return (payload + "\n").encode("utf-8"), count / RATE


class ProcessMonitor:
    def __init__(self, pid):
        self.root = psutil.Process(pid)
        self.peak = 0
        self.stop = Event()
        self.thread = Thread(target=self.poll, daemon=True)
        self.thread.start()

    def processes(self):
        try:
            return [self.root, *self.root.children(recursive=True)]
        except psutil.NoSuchProcess:
            return []

    def counters(self):
        resident, cpu = 0, 0
        for process in self.processes():
            try:
                memory = process.memory_info()
                times = process.cpu_times()
            except psutil.NoSuchProcess:
                continue
            resident += memory.rss
            cpu += times.user + times.system
        return resident, cpu

    def poll(self):
        while not self.stop.is_set():
            self.peak = max(self.peak, self.counters()[0])
            self.stop.wait(0.02)

    def close(self):
        self.stop.set()
        self.thread.join()


def requests(process, responses):
    for line in process.stdout:
        responses.put(line)
    responses.put(b"")


def invoke(worker, request, started=None, cold=False):
    process, monitor, responses = worker
    baseline = 0 if cold else monitor.counters()[1]
    start = time.perf_counter() if started is None else started
    process.stdin.write(request)
    process.stdin.flush()
    try:
        line = responses.get(timeout=90)
    except Empty as error:
        raise RuntimeError("Expression worker exceeded the benchmark timeout") from error
    elapsed = time.perf_counter() - start
    if not line:
        raise RuntimeError("Expression worker exited without a response")
    resident, cpu = monitor.counters()
    return {
        "wall_ms": round(elapsed * 1000, 1),
        "cpu_ms": round((cpu - baseline) * 1000, 1),
        "logical_cpus": round((cpu - baseline) / elapsed, 2),
        "rss_mib": round(resident / 2**20, 1),
    }, json.loads(line)


def expression(worker, request, started=None, cold=False):
    metrics, reply = invoke(worker, request, started, cold)
    return {**metrics, "expression": reply["expression"]}


def transcript(worker, request, started=None, cold=False):
    metrics, reply = invoke(worker, request, started, cold)
    if type(reply.get("text")) is not str or not reply["text"].strip():
        raise RuntimeError("Parakeet did not produce a transcript for the benchmark clip")
    return metrics


@contextmanager
def active_worker(python, model_args):
    started = time.perf_counter()
    process = subprocess.Popen(
        [str(python), "-I", "-u", *model_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    )
    monitor = ProcessMonitor(process.pid)
    responses = Queue()
    reader = Thread(target=requests, args=(process, responses), daemon=True)
    reader.start()
    try:
        yield started, (process, monitor, responses)
    finally:
        monitor.close()
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            for child in reversed(monitor.processes()):
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
            process.wait()
        reader.join()
        process.stdout.close()


def benchmark(model, model_args, inputs, repetitions):
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    with active_worker(python, model_args) as (started, worker):
        _, (first, seconds) = inputs[0]
        cold = expression(worker, first, started=started, cold=True)
        cold["audio_seconds"] = seconds
        cold["peak_rss_mib"] = round(worker[1].peak / 2**20, 1)
        warm = []
        for name, (request, seconds) in inputs:
            samples = [expression(worker, request) for _ in range(repetitions)]
            warm.append({
                "clip": name,
                "audio_seconds": seconds,
                "p50_wall_ms": statistics.median(sample["wall_ms"] for sample in samples),
                "max_wall_ms": max(sample["wall_ms"] for sample in samples),
                "samples": samples,
            })
        return {
            "model": model,
            "cold": cold,
            "warm": warm,
            "peak_rss_mib": round(worker[1].peak / 2**20, 1),
            "enriched": sum(
                sample["expression"] is not None for case in warm for sample in case["samples"]
            ),
        }


def projected_delivery(ready_ms, transcript_ms, preparation_ms, classified):
    check_ms = transcript_ms + preparation_ms
    wait_ms = min(OPTIONAL_WAIT_MS, max(0, ENRICHMENT_DEADLINE_MS - check_ms),
                  max(0, ready_ms - check_ms))
    return {
        "prep_ms": preparation_ms,
        "expression_delivered": (
            classified and ready_ms <= ENRICHMENT_DEADLINE_MS and ready_ms <= check_ms + wait_ms
        ),
        "wait_ms": round(wait_ms, 1),
    }


def simultaneous(pool, asr, model, request, cold=False):
    start = time.perf_counter()
    future = pool.submit(expression, model, request, start, cold)
    recognized = transcript(asr, request, start, cold)
    classified = future.result()
    return {
        "parakeet": recognized,
        "expression": classified,
        "projected_delivery": [
            projected_delivery(classified["wall_ms"], recognized["wall_ms"], prep,
                               classified["expression"] is not None)
            for prep in (0, 100, 250, 500)
        ],
    }


def alongside_parakeet(large_args, inputs, repetitions):
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    with (
        active_worker(PARAKEET_PYTHON, [str(PARAKEET_WORKER), "transcribe"]) as (_, asr),
        active_worker(python, large_args) as (_, model),
        ThreadPoolExecutor(max_workers=1) as pool,
    ):
        cold = simultaneous(pool, asr, model, inputs[0][1][0], cold=True)
        warm = []
        for name, (request, seconds) in inputs:
            samples = []
            for _ in range(repetitions):
                baseline = transcript(asr, request)
                paired = simultaneous(pool, asr, model, request)
                samples.append({"parakeet_only": baseline, **paired})
            warm.append({"clip": name, "audio_seconds": seconds, "samples": samples})
        return {"cold": cold, "warm": warm, "expression_peak_rss_mib": round(model[1].peak / 2**20, 1)}


def worker_args(model, threads, assets=None):
    folder = str(ROOT / model)
    if threads is None and assets is None:
        return [str(WORKER), folder]
    return [
        "-c", BENCHMARK_ADAPTER, str(WORKER),
        json.dumps(assets) if assets is not None else "",
        str(threads) if threads is not None else "", folder,
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wavs", type=Path, nargs="+")
    parser.add_argument("--repetitions", type=int, default=5, choices=range(1, 31),
                        metavar="1-30")
    parser.add_argument("--threads", type=int, choices=range(1, 9), metavar="1-8",
                        help="override the CPU worker thread count for comparison")
    parser.add_argument("--compare-base", action="store_true")
    parser.add_argument("--alongside-parakeet", action="store_true",
                        help="measure CPU contention and project expression availability during preparation")
    args = parser.parse_args()
    inputs = [(wav.name, audio_request(wav)) for wav in args.wavs]
    large_args = worker_args(SETUP["LARGE_MODEL"], args.threads)
    results = [benchmark("large", large_args, inputs, args.repetitions)]
    if args.compare_base:
        base_args = worker_args(SETUP["BASE_MODEL"], args.threads, SETUP["BASE_ASSETS"])
        results.append(benchmark("base", base_args, inputs, args.repetitions))
    report = {"logical_cpus": os.cpu_count(), "results": results}
    if args.alongside_parakeet:
        report["alongside_parakeet"] = alongside_parakeet(large_args, inputs, args.repetitions)
    print(json.dumps(report, indent=2))
    if any(result["enriched"] == 0 for result in results):
        raise SystemExit("No warm audio was classified. Check the worker and the benchmark clips.")


if __name__ == "__main__":
    main()

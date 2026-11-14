"""Single-owner maintenance operator. Plan is read-only; live entry requires later handoff.

The handoff argument is an operator acknowledgement, not authentication or inferred
consent. Authority must come from a separate explicit message AFTER Ivy completes
its response. No timer, file watcher, daemon, second writer or automatic live request.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-recovery-a88ccbd-20261114")
PIN = Path("D:/Hermes/profiles/ivy/cache/scratch/stellar-339-application-prep-20261113")
REPORT = OUT / "RESULT-utc-guard.json"
SESSION = "01a1d110-be3a-7601-8966-985df380586a"
CANDIDATE = "6ebd6d755f607fc839f032109c5afc65ee9ab681"
BASE = "3b421578588243f920886e6fe79a6faa87ea026e"
BINARY = (
    ROOT
    / "artifacts/issue-339/recovery-a88ccbd-20261114/portable/stellar-desktop-a0eea43-a88ccbd.exe"
)
EXE_SHA = "619f72a5104b3d6a8e561ca8345cb7d709cc840a6d29e45aa0d9270827be304b"
PROFILES = sorted(
    [
        "default",
        "architect",
        "architect-cloud",
        "art-director",
        "designer",
        "foreman",
        "foreman-cloud",
        "ivy",
        "mira",
        "nova",
        "peon-cloud",
    ]
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def protected_inputs():
    return [
        PIN / "source/scripts/install.ps1",
        PIN / "helpers/capture-application-state.py",
        PIN / "source/gateway/status.py",
        PIN / "source-candidate.json",
        Path(__file__).with_name("operator_provenance.py"),
    ]


def desktop_identity(name, executable):
    if not name.lower().startswith("stellar-desktop"):
        return None
    path = Path(executable).resolve()
    approved = {
        os.path.normcase(str(BINARY.resolve())): EXE_SHA,
        os.path.normcase(
            str(
                Path(
                    "D:/ai-repositories/stellar/target/debug/stellar-desktop.exe"
                ).resolve()
            )
        ): "0bd82436c3461296b8f9e583d6e9e35a3daff16dfac4dc5317cb020f604e0df6",
    }
    expected = approved.get(os.path.normcase(str(path)))
    return {
        "approved": expected is not None and digest(path) == expected,
        "exe": str(path),
        "expectedSha256": expected,
    }


def process_incarnation_guard(pid, created):
    return (
        f"$p=Get-Process -Id {pid}; "
        "$birth=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()/1000.0; "
        f"if([math]::Abs($birth-{created}) -gt 0.01){{throw 'Process incarnation changed'}}; "
    )


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".pending")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(value, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def snapshot():
    """Task-scoped file/process metadata only; no control socket or model request."""
    import psutil

    # Metadata classifiers come from the sealed PRIVATE source, not the tree being repaired.
    sys.path.insert(0, str(PIN / "source"))
    from gateway.status import (
        looks_like_gateway_runtime_command_line,
        read_runtime_status,
    )

    state_file = Path("D:/Hermes/gateway_state.json")
    state = read_runtime_status(state_file) or {}
    gateway = None
    if state.get("pid") and psutil.pid_exists(state["pid"]):
        gateway = psutil.Process(state["pid"])
        assert looks_like_gateway_runtime_command_line(
            subprocess.list2cmdline(gateway.cmdline())
        )
    gateway_pids = []
    for process in psutil.process_iter(["name"]):
        if (process.info["name"] or "").lower() not in {"python.exe", "hermes.exe"}:
            continue
        try:
            if looks_like_gateway_runtime_command_line(
                subprocess.list2cmdline(process.cmdline())
            ):
                gateway_pids.append(process.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    terminal = json.loads(
        subprocess.check_output(["hc", "get", os.environ["HC_TERMINAL_ID"], "--json"])
    )
    ancestry = []
    current = psutil.Process()
    while current and len(ancestry) < 16:
        ancestry.append(
            {
                "pid": current.pid,
                "name": current.name(),
                "exe": current.exe(),
                "parent": current.ppid(),
                "created": current.create_time(),
            }
        )
        current = current.parent()
    desktop = []
    for process in psutil.process_iter(["name"]):
        if (process.info["name"] or "").lower().startswith("stellar-desktop"):
            identity = desktop_identity(process.info["name"], process.exe())
            desktop.append(
                {
                    **identity,
                    "pid": process.pid,
                    "created": process.create_time(),
                    "exe": process.exe(),
                    "children": [
                        {"pid": c.pid, "created": c.create_time()}
                        for c in process.children(recursive=True)
                    ],
                }
            )
    assert os.environ.get("CODEX_THREAD_ID") == SESSION
    independent = terminal["parent"] is None and terminal["die_with_parent"] is False
    independent = independent and not set(gateway_pids).intersection(
        p["pid"] for p in ancestry
    )
    assert independent and terminal["state"] == "live"
    journal = (
        Path(os.environ["LOCALAPPDATA"]) / "dev.stellar.desktop/ivy/ivy-session.json"
    )
    data = json.loads(journal.read_text())
    plugin = Path("D:/Hermes/profiles/ivy/plugins/stellar-herdr")
    plugin_source = OUT / "stellar/config/hermes-plugins/stellar-herdr"
    plugin_files = {
        str(p.relative_to(plugin_source)).replace("\\", "/"): digest(p)
        for p in plugin_source.rglob("*")
        if p.is_file() and p.suffix in {".py", ".yaml"} and "__pycache__" not in p.parts
    }
    preimages = {
        name: digest(plugin / name) if (plugin / name).is_file() else None
        for name in plugin_files
    }
    return {
        "operator": terminal["address"],
        "session": SESSION,
        "independent": independent,
        "ordinaryToken": not bool(ctypes.windll.shell32.IsUserAnAdmin()),
        "ancestry": ancestry,
        "gateway": {
            "pid": gateway.pid if gateway else None,
            "live": gateway is not None,
            "created": gateway.create_time() if gateway else None,
            "code": state.get("code_sha"),
            "state": state.get("gateway_state"),
            "allGatewayPids": gateway_pids,
            "profiles": sorted(state.get("served_profiles", [])),
            "activeAgents": state.get("active_agents"),
            "activeWorkCount": len(state["active_work"])
            if isinstance(state.get("active_work"), list)
            else None,
        },
        "desktops": desktop,
        "conversation": {
            k: data.get(k)
            for k in [
                "session_id",
                "input_id",
                "admission_id",
                "generation",
                "unsettled",
                "pending_reset",
            ]
        },
        "journalSha256": digest(journal),
        "liveActions": False,
        "producerSource": str(plugin_source),
        "producerTarget": str(plugin),
        "producerPostimages": plugin_files,
        "producerPreimages": preimages,
        "producerMatchesPin": preimages == plugin_files,
        "externalInterpreter": sys.executable,
        "externalPsutil": psutil.__file__,
        "classifierSource": str(PIN / "source/gateway/status.py"),
        "managedWriteAccess": "Not probed before maintenance handoff; normal approval/errors remain enforced",
    }


def admit(report, handoff, metadata, mode="cutover"):
    if report.get("status") != "GREEN":
        raise RuntimeError(
            "BLOCKED: " + "; ".join(report.get("blockers", ["Unqualified recovery"]))
        )
    required = "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + digest(REPORT)[:16]
    if handoff != required:
        raise RuntimeError(
            "Separate explicit maintenance handoff missing; no live action"
        )
    if report.get("candidate") != CANDIDATE or report.get("desktopSha256") != EXE_SHA:
        raise RuntimeError("Reviewed version transition required")
    if report.get("operatorSha256") != digest(Path(__file__)):
        raise RuntimeError("Operator differs from reviewed qualification")
    helpers = report.get("helperHashes", {})
    if set(helpers) != {str(path) for path in protected_inputs()} or any(
        digest(Path(name)) != expected for name, expected in helpers.items()
    ):
        raise RuntimeError(
            "Execution helper/bootstrap differs from reviewed qualification"
        )
    if report.get("producerPostimages") != metadata.get("producerPostimages"):
        raise RuntimeError("Producer inventory differs from reviewed pinned source")
    if any(not app.get("approved") for app in metadata.get("desktops", [])):
        raise RuntimeError(
            "Unexpected Desktop executable identity; no close or shared mutation"
        )
    if (
        not metadata["independent"]
        or not metadata["ordinaryToken"]
        or metadata["session"] != SESSION
    ):
        raise RuntimeError("External same-owner ordinary-account operator required")
    if metadata["gateway"]["profiles"] != PROFILES:
        if mode != "recover" or metadata["gateway"]["live"]:
            raise RuntimeError(
                "Shared-profile scope changed; do not stop an unfamiliar host"
            )
        before = json.loads((OUT / "operator-metadata.json").read_text())
        if before["gateway"]["profiles"] != PROFILES:
            raise RuntimeError("No recorded owned recovery scope")
    if set(metadata["gateway"]["allGatewayPids"]) != (
        {metadata["gateway"]["pid"]} if metadata["gateway"]["live"] else set()
    ):
        raise RuntimeError("Unexpected separate gateway; no --all operation")
    if metadata["gateway"]["live"] and (
        metadata["gateway"]["activeAgents"] != 0
        or metadata["gateway"]["activeWorkCount"] != 0
    ):
        raise RuntimeError("Host not quiescent; never interrupt active Ivy turn")
    if not metadata["gateway"]["live"] and mode != "recover":
        raise RuntimeError("Use explicit recovery mode for a stopped host")
    if metadata["conversation"]["pending_reset"] is not None:
        raise RuntimeError("Conversation reset pending; no inferred resume target")


def workflow(mode, backend, journal):
    """Linear owned operation; durable continuation is not an admission/receipt claim."""
    steps = [
        "preflight",
        "close_desktop",
        "stop_host",
        "capture_state",
        "apply_source",
        "verify_source",
        "publish_producer",
        "restore_origin",
        "start_host",
        "health",
        "launch_desktop",
        "resume_check",
    ]
    state = {
        "mode": mode,
        "completed": [],
        "phase": "PREPARING",
        "canonicalReceipt": False,
    }
    save(journal, state)
    try:
        for step in steps:
            state["phase"] = step
            save(journal, state)
            backend(step, mode)
            state["completed"].append(step)
            save(journal, state)
        state["phase"] = "AWAIT_ORDINARY_INTERACTION"
        save(journal, state)
    except Exception as error:
        state.update(
            {
                "phase": "RECOVERY_REQUIRED",
                "error": str(error),
                "stateRestorePerformed": False,
            }
        )
        save(journal, state)
        raise
    return state


class Maintained:
    def __init__(self, metadata, run):
        self.metadata, self.run = metadata, run
        self.env = dict(
            os.environ,
            HERMES_HOME="D:/Hermes",
            HERMES_RUNTIME_DIR="D:/Hermes/tools",
            HERMES_REPO_URL=str(
                PIN / "hermes-notification-candidate-v1-from-3b.bundle"
            ),
        )
        self.target = (
            CANDIDATE  # Forward recovery retains the candidate and all new records.
        )

    def command(self, argv):
        subprocess.run(list(map(str, argv)), env=self.env, cwd=PIN, check=True)

    def __call__(self, step, mode):
        import psutil

        hermes = ["D:/Hermes/bin/hermes.exe", "-p", "default", "gateway"]
        if step == "preflight":
            assert digest(BINARY) == EXE_SHA
            assert (
                digest(PIN / "hermes-notification-candidate-v1-from-3b.bundle")
                == "5b695d97fab4be189fc1929f455c11e6ef90706ebba63469abdb5fb5820769d0"
            )
            claim = json.loads(
                subprocess.check_output(
                    [
                        "node",
                        "tools/policy/manage-issue-worktree.mjs",
                        "inspect",
                        "339",
                    ],
                    cwd=ROOT,
                )
            )
            assert claim["state"] == "active" and claim["sessionId"] == SESSION
            from datetime import datetime, timezone

            assert datetime.fromisoformat(
                claim["expiresAt"].replace("Z", "+00:00")
            ) > datetime.now(timezone.utc)
            issue = json.loads(
                subprocess.check_output(
                    ["gh", "issue", "view", "339", "--json", "state,labels"], cwd=ROOT
                )
            )
            assert issue["state"] == "OPEN" and "status:in-progress" in {
                label["name"] for label in issue["labels"]
            }
            assert not subprocess.check_output(
                ["git", "-C", "D:/Hermes/hermes-agent", "status", "--porcelain"]
            ).strip()
            current = snapshot()
            assert current["producerPreimages"] == self.metadata["producerPreimages"]
            approved = json.loads((OUT / "operator-metadata.json").read_text())
            assert (
                current["conversation"]["session_id"]
                == approved["conversation"]["session_id"]
            )
            assert current["conversation"]["pending_reset"] is None
        elif step == "close_desktop":
            assert len(self.metadata["desktops"]) <= 1
            for app in self.metadata["desktops"]:
                assert (
                    abs(psutil.Process(app["pid"]).create_time() - app["created"])
                    < 0.01
                )
                script = (
                    process_incarnation_guard(app["pid"], app["created"])
                    + "if(-not $p.CloseMainWindow()){throw 'Graceful close refused'}; if(-not $p.WaitForExit(15000)){throw 'Desktop still live'}"
                )
                self.command(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        script,
                    ]
                )
                for child in app["children"]:
                    if (
                        psutil.pid_exists(child["pid"])
                        and abs(
                            psutil.Process(child["pid"]).create_time()
                            - child["created"]
                        )
                        < 0.01
                    ):
                        raise RuntimeError(
                            "Owned Desktop child remains; no force kill or host stop"
                        )
        elif step == "stop_host":
            if self.metadata["gateway"]["live"]:
                self.command([*hermes, "stop", "--all"])
        elif step == "capture_state":
            self.command(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    PIN / "helpers/capture-application-state.py",
                    "--capture-runtime",
                    self.run / "state-snapshot",
                ]
            )
        elif step == "apply_source":
            self.command(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-File",
                    PIN / "source/scripts/install.ps1",
                    "-Branch",
                    "stellar-339-notification-candidate-v1",
                    "-Commit",
                    self.target,
                    "-HermesHome",
                    "D:/Hermes",
                    "-InstallDir",
                    "D:/Hermes/hermes-agent",
                    "-NonInteractive",
                ]
            )
        elif step == "verify_source":
            head = (
                subprocess.check_output(
                    ["git", "-C", "D:/Hermes/hermes-agent", "rev-parse", "HEAD"]
                )
                .decode()
                .strip()
            )
            assert head == self.target
            for item in json.loads((PIN / "source-candidate.json").read_text())[
                "files"
            ]:
                assert (
                    digest(Path("D:/Hermes/hermes-agent") / item["path"])
                    == item["candidate_sha256"]
                )
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    str(Path(__file__).with_name("operator_provenance.py")),
                    "--source",
                    "D:/Hermes/hermes-agent",
                ],
                env=self.env,
                cwd=PIN,
                capture_output=True,
                text=True,
                check=True,
            )
            proof = json.loads(result.stdout)
            assert (
                proof["fixtureOnly"] is False
                and proof["bootstrapMarkerChecked"] is True
            )
            save(self.run / "activation-provenance.json", proof)
        elif step == "publish_producer":
            # Repository's maintained personal-Ivy installation: Python files/plugin.yaml only.
            # integration/settings.json and observations.sqlite3 remain in place, never copied back.
            import shutil

            source, target = (
                Path(self.metadata["producerSource"]),
                Path(self.metadata["producerTarget"]),
            )
            assert (
                target == Path("D:/Hermes/profiles/ivy/plugins/stellar-herdr")
                and not target.is_symlink()
                and not target.is_junction()
            )
            for name, expected in self.metadata["producerPostimages"].items():
                original, actual = (
                    self.metadata["producerPreimages"][name],
                    target / name,
                )
                assert (digest(actual) if actual.is_file() else None) == original
                assert digest(source / name) == expected
            backup = self.run / "producer-before"
            backup.mkdir()
            for name in self.metadata["producerPostimages"]:
                actual = target / name
                if actual.is_file():
                    saved = backup / name
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(actual, saved)
                temporary = actual.with_suffix(actual.suffix + ".pending")
                shutil.copyfile(source / name, temporary)
                os.replace(temporary, actual)
        elif step == "restore_origin":
            origin = json.loads((PIN / "POST-GUARDS.json").read_text())[
                "originalUpstreamOrigin"
            ]
            self.command(
                [
                    "git",
                    "-C",
                    "D:/Hermes/hermes-agent",
                    "remote",
                    "set-url",
                    "origin",
                    origin,
                ]
            )
        elif step == "start_host":
            self.command([*hermes, "restart", "--all", "--detach"])
        elif step == "health":
            for _ in range(60):
                current = snapshot()
                if (
                    current["gateway"]["live"]
                    and current["gateway"]["state"] == "running"
                    and current["gateway"]["code"] == self.target
                    and current["gateway"]["profiles"] == PROFILES
                    and current["gateway"]["created"]
                    != self.metadata["gateway"]["created"]
                ):
                    save(self.run / "new-host.json", current)
                    break
                time.sleep(1)
            else:
                raise RuntimeError(
                    "Host health/provenance not established; no model probe or forced stop"
                )
        elif step == "launch_desktop":
            script = f"$p=Start-Process -FilePath '{BINARY}' -WorkingDirectory '{ROOT}' -PassThru; @{{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
            result = subprocess.check_output(
                ["powershell.exe", "-NoProfile", "-Command", script], env=self.env
            )
            save(self.run / "new-desktop.json", json.loads(result))
        elif step == "resume_check":
            after = snapshot()
            assert (
                after["conversation"]["session_id"]
                == self.metadata["conversation"]["session_id"]
            )
            assert after["conversation"]["pending_reset"] is None
            save(self.run / "resume-metadata.json", after)
        else:
            raise ValueError(step)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["plan", "cutover", "recover"])
    parser.add_argument("--handoff", default="")
    args = parser.parse_args()
    metadata = snapshot()
    if args.mode == "plan":
        save(OUT / "operator-metadata.json", metadata)
        print(json.dumps(metadata, indent=2))
        return
    report = json.loads(REPORT.read_text())
    # Read the supported live-work metadata ONLY after the later explicit handoff.
    # Plan/current-turn verification uses files/process metadata and makes no gateway request.
    acknowledgement = "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + digest(REPORT)[:16]
    if (
        report.get("status") == "GREEN"
        and args.handoff == acknowledgement
        and metadata["gateway"]["live"]
    ):
        from hermes_cli.gateway_lifecycle_guards import live_work

        work = live_work(Path("D:/Hermes"))
        if isinstance(work, dict):
            metadata["gateway"]["activeAgents"] = work.get("active_agents")
            metadata["gateway"]["activeWorkCount"] = (
                len(work["active_work"])
                if isinstance(work.get("active_work"), list)
                else None
            )
    admit(report, args.handoff, metadata, args.mode)
    run = OUT / ("operation-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    run.mkdir()  # Refuse a duplicate operation rather than overwrite a continuation.
    save(run / "before.json", metadata)
    workflow(args.mode, Maintained(metadata, run), run / "CONTINUATION.json")


if __name__ == "__main__":
    main()

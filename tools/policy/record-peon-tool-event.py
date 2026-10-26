#!/usr/bin/python3
"""Send bounded, content-free Hermes tool hook metadata to the attempt meter."""

import hashlib
import json
import sys
import urllib.request


def bounded_size(value):
    return min(len(json.dumps(value, ensure_ascii=False).encode("utf-8")), 1_000_000)


def sanitized_event(payload):
    phase = payload.get("hook_event_name")
    if phase not in ("pre_tool_call", "post_tool_call"):
        raise ValueError("unknown hook phase")
    name = payload.get("tool_name")
    if not isinstance(name, str) or not name.isidentifier() or len(name) > 64:
        raise ValueError("invalid tool name")
    extra = payload.get("extra") or {}
    call_id = extra.get("tool_call_id")
    if not isinstance(call_id, str) or not call_id or len(call_id) > 256:
        raise ValueError("missing tool call identity")
    args = payload.get("tool_input")
    event = {
        "phase": "pre" if phase == "pre_tool_call" else "post",
        "callId": hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:24],
        "toolName": name,
        "argumentBytes": bounded_size(args),
        "argumentCount": len(args) if isinstance(args, dict) else 0,
    }
    if phase == "post_tool_call":
        status = extra.get("status")
        event["status"] = status if status in ("ok", "error", "cancelled", "blocked", "timeout") else "unknown"
        duration = extra.get("duration_ms")
        event["elapsedMs"] = duration if isinstance(duration, int) and 0 <= duration <= 900_000 else None
        result = extra.get("result")
        event["outputBytes"] = bounded_size(result)
        try:
            parsed = json.loads(result) if isinstance(result, str) else result
        except (ValueError, TypeError):
            parsed = None
        code = parsed.get("exit_code", parsed.get("exitCode")) if isinstance(parsed, dict) else None
        event["exitCode"] = code if isinstance(code, int) and -255 <= code <= 255 else None
    return event


def main():
    payload = json.load(sys.stdin)
    event = sanitized_event(payload)
    request = urllib.request.Request(
        "http://peon-meter:18437/tool-event",
        data=json.dumps(event, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=2) as response:
        if response.status != 204:
            raise RuntimeError("tool evidence was not accepted")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A missing pre-tool observation blocks the tool; post-tool failure
        # remains visible as an unmatched pre event in the meter snapshot.
        if "pre_tool_call" in sys.argv:
            print('{"action":"block","message":"Tool evidence unavailable."}')
            raise SystemExit(2)
        raise SystemExit(1)

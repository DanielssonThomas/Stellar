import json
import os
import sys
import urllib.request

sys.dont_write_bytecode = True
os.environ["HERMES_HOME"] = "D:/Hermes"
sys.path.insert(0, "D:/Hermes/hermes-agent")


def main():
    from hermes_cli.local_runtime.endpoint import managed_root

    raw = sys.stdin.buffer.read(8193)
    if not raw or len(raw) > 8192:
        return
    prompt = raw.decode("utf-8")
    endpoint = managed_root()
    if not endpoint or endpoint[0] != "http://127.0.0.1:18434":
        return
    root, key = endpoint
    payload = {
        "model": "Qwen3.5-9B-Q5_K_S",
        "messages": [
            {"role": "system", "content": "Clean up the finalized dictated request. Remove filler and apply explicit revisions. Preserve all identifiers, paths, constraints, and intent. Do not invent requirements. Return only the cleaned request."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0, "max_tokens": 1024, "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        root + "/v1/chat/completions", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=45) as response:
        body = response.read(32769)
    if len(body) > 32768:
        return
    choice = json.loads(body)["choices"][0]
    message = choice["message"]
    text = message.get("content")
    if choice.get("finish_reason") != "stop" or message.get("tool_calls") or not isinstance(text, str):
        return
    print(json.dumps({"text": text}, ensure_ascii=True))


try:
    main()
except Exception:
    pass

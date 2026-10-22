import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [corpusPath] = process.argv.slice(2);
if (!corpusPath)
  throw new Error('Usage: tokenize-corpus-via-local-qwen <corpus-json>');
if (process.platform !== 'win32')
  throw new Error(
    'This bounded bridge is intended for the trusted Windows host.',
  );

const corpus = await readFile(corpusPath, 'utf8');
const python = String.raw`
import json, sys, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:18435"
DEADLINE = time.monotonic() + 90
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def post(path, payload):
    if path not in ("/tokenize", "/apply-template"):
        raise RuntimeError("endpoint_not_allowlisted")
    if time.monotonic() > DEADLINE:
        raise RuntimeError("probe_deadline")
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with OPENER.open(request, timeout=4) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError("http_" + str(error.code)) from None
    except Exception:
        raise RuntimeError("local_transport_or_json_failure") from None
    return data

def count_raw(content, add_special=False):
    result = post("/tokenize", {"content": content, "add_special": add_special})
    tokens = result.get("tokens")
    if not isinstance(tokens, list):
        raise RuntimeError("invalid_tokenizer_response")
    return len(tokens)

def measure_prompt(body):
    body = dict(body)
    body["messages"] = [
        dict(message) for message in body.get("messages", [])
    ]
    for message in body["messages"]:
        if message.get("role") == "system" and message.get("content") == "__SYNTHETIC_FIXED_SYSTEM__":
            message["content"] = SYNTHETIC_FIXED_SYSTEM
    formatted = post("/apply-template", body)
    prompt = formatted.get("prompt")
    if not isinstance(prompt, str):
        raise RuntimeError("invalid_template_response")
    return count_raw(prompt, add_special=True)

try:
    corpus = json.load(sys.stdin)
    target_system_tokens = corpus.get("syntheticFixedSystemTokens")
    if not isinstance(target_system_tokens, int) or target_system_tokens < 1:
        raise RuntimeError("invalid_fixed_system_target")

    seed = (
        "Synthetic fixed worker guidance: obey repository instructions; keep work inside the assigned issue checkout; "
        "protect governance files; use only scoped worker credentials; run trusted verification; report exact outcomes. "
    )
    candidate = seed * max(10, target_system_tokens // 20 + 20)
    low, high = 0, len(candidate)
    while low < high:
        middle = (low + high + 1) // 2
        if count_raw(candidate[:middle]) <= target_system_tokens:
            low = middle
        else:
            high = middle - 1
    SYNTHETIC_FIXED_SYSTEM = candidate[:low]
    current_system_tokens = count_raw(SYNTHETIC_FIXED_SYSTEM)
    suffixes = [" x", " a", " the", " and", " to", " of", " .", " 1", "\n", " policy"]
    while current_system_tokens < target_system_tokens:
        best = None
        for suffix in suffixes:
            proposed = count_raw(SYNTHETIC_FIXED_SYSTEM + suffix)
            if current_system_tokens < proposed <= target_system_tokens:
                if best is None or proposed > best[0]:
                    best = (proposed, suffix)
        if best is None:
            raise RuntimeError("fixed_system_token_calibration_unavailable")
        current_system_tokens, suffix = best
        SYNTHETIC_FIXED_SYSTEM += suffix
    if current_system_tokens != target_system_tokens:
        raise RuntimeError("fixed_system_token_calibration_mismatch")

    result = {
        "tokenizeOnly": [],
        "promptScenarios": {},
        "syntheticFixedSystemTokens": current_system_tokens,
    }
    for entry in corpus["tokenizeOnly"]:
        result["tokenizeOnly"].append({
            "kind": entry["kind"],
            "group": entry.get("group"),
            "name": entry.get("name"),
            "tokens": count_raw(entry["content"], entry["addSpecial"]),
        })
    for scenario, bodies in corpus["requests"].items():
        result["promptScenarios"][scenario] = [measure_prompt(body) for body in bodies]
    result["endpointClass"] = "local-tokenize-and-apply-template-only"
    result["completionRequests"] = 0
    result["meteringProxyRequests"] = 0
    print(json.dumps(result, separators=(",", ":")))
except Exception as error:
    category = str(error) if str(error).startswith(("http_", "invalid_", "probe_", "endpoint_", "local_")) else "unknown_tokenizer_failure"
    print(json.dumps({"failureCategory": category, "completionRequests": 0, "meteringProxyRequests": 0}))
    sys.exit(2)
`;

const result = spawnSync(
  'wsl.exe',
  [
    '-d',
    'Ubuntu',
    '-u',
    'peon',
    '--',
    'podman',
    'exec',
    '-i',
    '--user',
    '1001:1001',
    'stellar-peon-qwen',
    'python3',
    '-c',
    python,
  ],
  {
    input: corpus,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 100_000,
    maxBuffer: 2 * 1024 * 1024,
  },
);

if (result.error)
  throw new Error('Local tokenizer bridge failed or timed out.');
if (result.status !== 0)
  throw new Error(result.stdout.trim() || 'Local tokenizer bridge failed.');
process.stdout.write(result.stdout);

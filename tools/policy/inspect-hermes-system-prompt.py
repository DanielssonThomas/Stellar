#!/usr/bin/env python3
"""Attest that the pinned Hermes CLI prompt embeds the exact workspace AGENTS.md.

This offline probe emits hashes and a match count only. It does not run Hermes
chat, initialize a model request, or print repository instructions.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

os.environ["HERMES_SINGLE_QUERY_SESSION"] = "1"

from agent.coding_context import resolve_runtime_mode  # noqa: E402
from agent.oneshot_footprint import prune_oneshot_tools  # noqa: E402
from agent.system_prompt import build_system_prompt
from hermes_cli.config import load_config
from hermes_cli.prompt_size import _build_inspection_agent
from hermes_cli.toolset_scope import toolset_allowed_for_platform
import model_tools  # noqa: E402


agents_path = Path("/workspace/AGENTS.md")
peon_soul_path = Path("/tmp/.hermes/SOUL.md")
if not agents_path.is_file() or agents_path.is_symlink():
    raise SystemExit("Trusted workspace AGENTS.md is unavailable.")
if not peon_soul_path.is_file() or peon_soul_path.is_symlink():
    raise SystemExit("Trusted Peon SOUL.md is unavailable.")

raw_agents = agents_path.read_bytes()
raw_peon_soul = peon_soul_path.read_bytes()
try:
    agents_text = raw_agents.decode("utf-8-sig")
    peon_soul_text = raw_peon_soul.decode("utf-8-sig")
except UnicodeDecodeError as error:
    raise SystemExit("Trusted guidance is not valid UTF-8.") from error

def embedded_copy_count(prompt_text: str, trusted_text: str, allow_final_newline: bool = False) -> int:
    # Hermes normalizes Windows line endings before embedding trusted text.
    embedded = trusted_text.replace("\r\n", "\n")
    if not embedded:
        return 0
    matches = prompt_text.count(embedded)
    if matches == 0 and allow_final_newline and embedded.endswith("\n"):
        # Hermes may omit one final newline from one-line AGENTS.md.
        matches = prompt_text.count(embedded[:-1])
    return matches


prompt = build_system_prompt(_build_inspection_agent("cli"))
matches = embedded_copy_count(prompt, agents_text, allow_final_newline=True)
peon_soul_matches = embedded_copy_count(prompt, peon_soul_text)
if not agents_text or matches != 1 or not peon_soul_text or peon_soul_matches != 1:
    raise SystemExit("Hermes system prompt did not contain one exact copy of trusted guidance and Peon identity.")

config = load_config()
model_config = config.get("model") or {}
mode = resolve_runtime_mode(
    platform="cli",
    cwd="/opt/hermes/hermes-agent",
    config=config,
    model=model_config.get("default"),
)
selection = mode.toolset_selection(config)
disabled = (config.get("agent") or {}).get("disabled_toolsets") or []
schemas = model_tools.get_tool_definitions(
    enabled_toolsets=selection,
    disabled_toolsets=disabled,
    quiet_mode=True,
)
schemas = prune_oneshot_tools(schemas)
schemas = [
    schema
    for schema in schemas
    if toolset_allowed_for_platform(
        model_tools.get_toolset_for_tool(schema["function"]["name"]), "cli"
    )
]

if sys.argv[1:] == ["--study-export"]:
    print(
        json.dumps(
            {
                "schema": "stellar.hermes-prompt-study/v1",
                "agentsSha256": hashlib.sha256(raw_agents).hexdigest(),
                "peonSoulSha256": hashlib.sha256(raw_peon_soul).hexdigest(),
                "systemPromptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "exactMatchCount": matches,
                "peonSoulExactMatchCount": peon_soul_matches,
                "model": model_config.get("default"),
                "systemPrompt": prompt,
                "toolSchemas": schemas,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    raise SystemExit(0)

print(
    json.dumps(
        {
            "schema": "stellar.hermes-system-prompt-attestation/v1",
            "agentsSha256": hashlib.sha256(raw_agents).hexdigest(),
            "peonSoulSha256": hashlib.sha256(raw_peon_soul).hexdigest(),
            "systemPromptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "exactMatchCount": matches,
            "peonSoulExactMatchCount": peon_soul_matches,
            "networkRequests": 0,
            "completionRequests": 0,
        },
        separators=(",", ":"),
    )
)

#!/usr/bin/env python3
"""Emit sanitized, offline schema measurements from the pinned Hermes runtime.

Run inside the immutable worker image with the production Peon config mounted at
``/workspace/peon-hermes-config.yaml`` and this script read-only mounted at
``/workspace/inspect-pinned-hermes.py``. It never prints schema content.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

os.environ["HERMES_SINGLE_QUERY_SESSION"] = "1"


config_path = Path("/tmp/.hermes/config.yaml")
active_profile_mount = os.environ.get("PEON_HERMES_ACTIVE_PROFILE") == "1"
if active_profile_mount:
    if not config_path.is_file() or config_path.is_symlink():
        raise SystemExit("The active profile must be mounted as a regular read-only config file.")
elif config_path.exists() or config_path.is_symlink():
    config_path.unlink()
if not active_profile_mount:
    config_path.symlink_to("/workspace/peon-hermes-config.yaml")

from hermes_cli.config import load_config_readonly  # noqa: E402
from agent.coding_context import resolve_runtime_mode  # noqa: E402
from agent.oneshot_footprint import prune_oneshot_tools  # noqa: E402
from hermes_cli.toolset_scope import toolset_allowed_for_platform  # noqa: E402
import model_tools  # noqa: E402


config = load_config_readonly()
mode = resolve_runtime_mode(
    platform="cli",
    cwd="/opt/hermes/hermes-agent",
    config=config,
    model=(config.get("model") or {}).get("default"),
)
selection = mode.toolset_selection(config)
if not mode.is_coding or selection is None:
    raise SystemExit("Pinned config did not resolve to focus coding posture.")
mcp_selection = selection[1:]

disabled = (config.get("agent") or {}).get("disabled_toolsets") or []
raw_schemas = model_tools.get_tool_definitions(
    enabled_toolsets=selection,
    disabled_toolsets=disabled,
    quiet_mode=True,
    skip_tool_search_assembly=True,
)
schemas = model_tools.get_tool_definitions(
    enabled_toolsets=selection,
    disabled_toolsets=disabled,
    quiet_mode=True,
)


def cli_one_shot_schemas(definitions: list[dict]) -> list[dict]:
    definitions = prune_oneshot_tools(definitions)
    return [
        schema
        for schema in definitions
        if toolset_allowed_for_platform(
            model_tools.get_toolset_for_tool(schema["function"]["name"]), "cli"
        )
    ]


raw_schemas = cli_one_shot_schemas(raw_schemas)
schemas = cli_one_shot_schemas(schemas)

profile_disabled_toolsets = sorted(
    set(
        [
            *disabled,
            *mcp_selection,
            "browser",
            "clarify",
            "code_execution",
            "connections",
            "delegation",
            "memory",
            "session_search",
            "todo",
            "vision",
            "web",
        ]
    )
)
raw_config = Path("/workspace/peon-hermes-config.yaml").read_text(encoding="utf-8")
if "disabled_toolsets:" in raw_config:
    raise SystemExit("The mounted production config already declares disabled_toolsets.")
agent_marker = "agent:\n"
config_lines = raw_config.splitlines()
agent_line = next(
    (index for index, line in enumerate(config_lines) if line == "agent:"),
    None,
)
if agent_line is None or raw_config.count(agent_marker) != 1 or any(
    line and not line[0].isspace() for line in config_lines[agent_line + 1 :]
):
    raise SystemExit("Cannot safely derive a temporary profile from this config layout.")
direct_profile_source = os.environ.get("PEON_HERMES_PROFILE_SOURCE")
if active_profile_mount:
    profile_yaml = None
elif direct_profile_source:
    profile_source = Path(direct_profile_source)
    if profile_source != Path("/workspace/peon-hermes-narrow-config.yaml"):
        raise SystemExit("Direct profile source must use the fixed mounted path.")
    profile_yaml = profile_source.read_text(encoding="utf-8")
else:
    profile_yaml = raw_config.rstrip() + "\n  disabled_toolsets:\n"
    profile_yaml += "".join(f"    - {toolset}\n" for toolset in profile_disabled_toolsets)
if active_profile_mount:
    profile_config = config
    profile_mode = mode
    profile_selection = selection
    profile_disabled_toolsets = disabled
else:
    profile_path = Path("/tmp/peon-hermes-narrow-profile.yaml")
    profile_path.write_text(profile_yaml, encoding="utf-8")
    config_path.unlink()
    config_path.symlink_to(profile_path)
    profile_config = load_config_readonly()
    profile_mode = resolve_runtime_mode(
        platform="cli",
        cwd="/opt/hermes/hermes-agent",
        config=profile_config,
        model=(profile_config.get("model") or {}).get("default"),
    )
    profile_selection = profile_mode.toolset_selection(profile_config)
    if profile_selection != selection or not profile_mode.is_coding:
        raise SystemExit("Narrow profile changed coding posture or enabled toolsets.")
    profile_disabled_toolsets = (profile_config.get("agent") or {}).get("disabled_toolsets") or []
expected_disabled_toolsets = {
    "browser",
    "clarify",
    "code_execution",
    "connections",
    "delegation",
    "memory",
    "session_search",
    "todo",
    "vision",
    "web",
}
if (direct_profile_source or active_profile_mount) and set(profile_disabled_toolsets) != expected_disabled_toolsets:
    raise SystemExit("Mounted narrow profile does not match the reviewed disabled-toolset allowlist.")
if active_profile_mount:
    narrow_raw_schemas = raw_schemas
    narrow_schemas = schemas
else:
    narrow_raw_schemas = cli_one_shot_schemas(
        model_tools.get_tool_definitions(
            enabled_toolsets=profile_selection,
            disabled_toolsets=profile_disabled_toolsets,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )
    narrow_schemas = cli_one_shot_schemas(
        model_tools.get_tool_definitions(
            enabled_toolsets=profile_selection,
            disabled_toolsets=profile_disabled_toolsets,
            quiet_mode=True,
        )
    )


def summarize(definitions: list[dict]) -> dict:
    serialized = json.dumps(definitions, ensure_ascii=False, separators=(",", ":"))
    per_tool = []
    for schema in definitions:
        text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
        per_tool.append(
            {
                "name": schema["function"]["name"],
                "serializedChars": len(text),
                "serializedUtf8Bytes": len(text.encode("utf-8")),
            }
        )
    return {
        "toolCount": len(definitions),
        "aggregateSerializedChars": len(serialized),
        "aggregateSerializedUtf8Bytes": len(serialized.encode("utf-8")),
        "tools": per_tool,
    }


current_names = {schema["function"]["name"] for schema in schemas}
raw_names = {schema["function"]["name"] for schema in raw_schemas}
narrow_names_actual = {schema["function"]["name"] for schema in narrow_schemas}
narrow_raw_names = {
    schema["function"]["name"] for schema in narrow_raw_schemas
}


def synthetic_turn_validation(tool_name: str) -> tuple[object, list[dict]]:
    """Validate a synthetic tool call in Hermes without dispatching its executor."""
    from agent.turn_tool_validation import validate_tool_calls

    call = SimpleNamespace(
        id="synthetic-disabled-call",
        function=SimpleNamespace(name=tool_name, arguments="{}"),
    )
    assistant = SimpleNamespace(tool_calls=[call], content="")
    messages: list[dict] = []
    agent = SimpleNamespace(
        valid_tool_names=narrow_names_actual,
        _invalid_tool_retries=0,
        _invalid_json_retries=0,
        _uniquify_tool_call_ids=lambda calls, taken: None,
        _repair_tool_call=lambda name: None,
        _buffer_vprint=lambda *args, **kwargs: None,
        _vprint=lambda *args, **kwargs: None,
        _build_assistant_message=lambda message, finish: {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments,
                    },
                }
                for tool_call in message.tool_calls
            ],
        },
        _flush_status_buffer=lambda: None,
        _persist_session=lambda *args, **kwargs: None,
        log_prefix="offline-profile-probe",
        session_id="offline-profile-probe",
        provider=None,
        model=None,
        tools=narrow_schemas,
    )
    verdict = validate_tool_calls(
        agent,
        assistant,
        "tool_calls",
        messages=messages,
        conversation_history=[],
        api_call_count=1,
        effective_task_id="synthetic-profile-probe",
    )
    return verdict, messages


def rejected_by_turn_validation(disabled_name: str) -> bool:
    verdict, messages = synthetic_turn_validation(disabled_name)
    return (
        verdict.action == "continue"
        and not verdict.mixed_invalid_batch
        and any(message.get("role") == "tool" for message in messages)
    )


def accepted_by_turn_validation(enabled_name: str) -> bool:
    verdict, messages = synthetic_turn_validation(enabled_name)
    return (
        verdict.action != "continue"
        and not verdict.mixed_invalid_batch
        and not any(message.get("role") == "tool" for message in messages)
    )


def discoverable_tools(query: str) -> set[str]:
    result, underlying = model_tools._dispatch_bridge_tool(
        "tool_search",
        {"queries": [query], "limit": 20},
        profile_selection,
        profile_disabled_toolsets,
    )
    if underlying is not None or not isinstance(result, str):
        raise SystemExit("Pinned Tool Search did not return a bounded catalog result.")
    payload = json.loads(result)
    return set(payload.get("tools", {}))


discovered_process_tools = discoverable_tools("process manage")
discovered_browser_tools = discoverable_tools("browser vault")
discovered_web_tools = discoverable_tools("web search")
forbidden_direct_names = {
    "browser_exec",
    "browser_vault",
    "clarify",
    "delegate_task",
    "execute_code",
    "manage_connections",
    "memory",
    "session_search",
    "todo_list",
    "vision_analyze",
    "web_extract",
    "web_search",
}
forbidden_discoverable_names = forbidden_direct_names | {"browser_vault"}
turn_validation_rejects_disabled = {
    name: rejected_by_turn_validation(name)
    for name in ("web_search", "browser_exec", "delegate_task")
}
turn_validation_accepts_enabled = {
    name: accepted_by_turn_validation(name)
    for name in ("read_file", "search_files", "write_file", "patch", "terminal", "skills_list", "skill_view")
}
forbidden_schema_names = forbidden_direct_names & narrow_raw_names
if forbidden_schema_names:
    raise SystemExit("Disabled tool schema remained directly reachable.")
if "process_manage" not in discovered_process_tools:
    raise SystemExit("Required process capability is not discoverable in the narrow profile.")
if forbidden_discoverable_names & (discovered_browser_tools | discovered_web_tools):
    raise SystemExit("Disabled capability remained Tool Search-discoverable.")
if not all(turn_validation_rejects_disabled.values()):
    raise SystemExit("Pinned turn validation did not reject all disabled tool calls.")
if not all(turn_validation_accepts_enabled.values()):
    raise SystemExit("Pinned turn validation rejected a required task tool.")

required_direct = {
    "read_file",
    "search_files",
    "write_file",
    "patch",
    "terminal",
    "skills_list",
    "skill_view",
}
if not required_direct.issubset(narrow_names_actual):
    raise SystemExit("The narrow profile removed a required direct capability.")

result = {
    "pinnedConfig": {
        "posture": mode.kind,
        "configMode": mode.config_mode,
        "surface": mode.surface,
        "selection": selection,
        "enabledMcpServerCount": len(mcp_selection),
        "oneShotSkillManageRemoved": "skill_manage" not in current_names,
    },
    "currentVisible": summarize(schemas),
    "currentReachableWithoutToolSearch": summarize(raw_schemas),
    "currentDeferredNames": sorted(raw_names - current_names),
    "narrowProfile": summarize(narrow_schemas),
    "narrowProfileReachableWithoutToolSearch": summarize(narrow_raw_schemas),
    "narrowProfileDisabledToolsets": profile_disabled_toolsets,
    "narrowProfileDeferredNames": sorted(narrow_raw_names - narrow_names_actual),
    "narrowProfileUnavailableNames": [],
    "narrowProfileOmittedNames": sorted(raw_names - narrow_raw_names),
    "narrowProfileRuntime": {
        "loadedThroughConfigLoader": True,
        "sameCodingPostureAndToolsetSelection": True,
        "requiredDirectCapabilitiesAvailable": sorted(required_direct),
        "processManageToolSearchDiscoverable": "process_manage" in discovered_process_tools,
        "browserVaultToolSearchDiscoverable": "browser_vault" in discovered_browser_tools,
        "disabledToolSearchNames": sorted(forbidden_discoverable_names & (discovered_browser_tools | discovered_web_tools)),
        "disabledDirectSchemasAbsent": sorted(forbidden_direct_names - narrow_raw_names),
        "disabledCallsRejectedByTurnValidation": turn_validation_rejects_disabled,
        "requiredCallsAcceptedByTurnValidation": turn_validation_accepts_enabled,
        "toolExecutorsStarted": False,
        "networkRequests": 0,
    },
}

source_dir = Path("/opt/hermes/hermes-agent")
agent_init_source = (source_dir / "agent/agent_init.py").read_text(encoding="utf-8")
turn_validation_source = (source_dir / "agent/turn_tool_round.py").read_text(encoding="utf-8")
bridge_source = (source_dir / "model_tools.py").read_text(encoding="utf-8")
result["dispatchScopeChecks"] = {
    "agentValidNamesDerivedFromVisibleSchemas": "agent.valid_tool_names = {tool[\"function\"][\"name\"] for tool in agent.tools}" in agent_init_source,
    "turnRejectsNamesOutsideVisibleSet": "tc.function.name not in agent.valid_tool_names" in turn_validation_source,
    "toolSearchBridgeRebuildsSameEnabledAndDisabledScope": "get_tool_definitions(enabled_toolsets=enabled_toolsets, disabled_toolsets=disabled_toolsets" in bridge_source,
}
if not all(result["dispatchScopeChecks"].values()):
    raise SystemExit("Pinned Hermes dispatch-scope source checks failed.")

print(
    json.dumps(
        {
            "schemas": {
                "currentVisible": schemas,
                "currentReachableWithoutToolSearch": raw_schemas,
                "narrowProfile": narrow_schemas,
                "narrowProfileReachableWithoutToolSearch": narrow_raw_schemas,
            },
            "measurements": result,
        },
        separators=(",", ":"),
    )
)

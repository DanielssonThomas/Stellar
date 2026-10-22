#!/usr/bin/env python3
"""Emit sanitized, offline schema measurements from the pinned Hermes runtime.

Run inside the immutable worker image with the production Peon config mounted at
``/workspace/peon-hermes-config.yaml`` and this script read-only mounted at
``/workspace/inspect-pinned-hermes.py``. It never prints schema content.
"""

from __future__ import annotations

import json
from pathlib import Path


config_path = Path("/tmp/.hermes/config.yaml")
if config_path.exists() or config_path.is_symlink():
    config_path.unlink()
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
narrow_raw_schemas = cli_one_shot_schemas(
    model_tools.get_tool_definitions(
        enabled_toolsets=selection,
        disabled_toolsets=profile_disabled_toolsets,
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
)
narrow_schemas = cli_one_shot_schemas(
    model_tools.get_tool_definitions(
        enabled_toolsets=selection,
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

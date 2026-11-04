pub const IVY_EVENT: &str = "ivy-state";
pub const WORKSPACE_EVENT: &str = "workspace-tool-request";
pub const WORKSPACE_REPLY_COMMAND: &str = "workspace_tool_reply";
pub const IVY_COMMANDS: [&str; 11] = [
    "ivy_connect",
    "ivy_snapshot",
    "ivy_submit",
    "ivy_cancel",
    "ivy_reconcile",
    "ivy_disconnect",
    "ivy_select_session",
    "ivy_clear_conversation",
    "ivy_new_session",
    "ivy_reload_mcp",
    "ivy_question_reply",
];

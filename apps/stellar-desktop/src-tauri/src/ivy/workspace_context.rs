/// Workspace sessions receive durable application guidance from their MCP server instructions.
/// Preserve the legacy envelope for retained CLI sessions which do not own that server.
pub fn prompt(text: String, workspace: bool) -> String {
    if workspace {
        return text;
    }
    format!(
        "This conversation is inside Stellar Desktop. Reply normally with plain text. Only for a requested visual presentation, return exact JSON {{\"text\":\"reply\",\"stellar_presentation\":{{\"component\":\"assistant_message\",\"title\":\"title\",\"body\":\"complete plain text\"}}}}. Only for requested activity closure, return {{\"text\":\"reply\",\"stellar_presentation\":{{\"action\":\"close_activity\"}}}}. No executable UI. Workspace tools are unavailable in this retained session; never claim pane actions succeeded. User message follows:\n{text}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_sessions_do_not_repeat_application_instructions_or_change_user_text() {
        let user = "Ivy, show the designer beside this checklist. 🪐";
        assert_eq!(prompt(user.into(), true), user);
        let legacy = prompt(user.into(), false);
        assert!(legacy.starts_with("This conversation is inside Stellar Desktop."));
        assert!(legacy.ends_with(user));
        assert!(legacy.contains("Workspace tools are unavailable"));
    }
}

use crate::contracts::{ShellError, ShellReply, ShellRequest};

#[tauri::command]
pub fn shell_status(request: ShellRequest) -> Result<ShellReply, ShellError> {
    crate::shell::status(request)
}

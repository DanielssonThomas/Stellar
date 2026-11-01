use crate::contracts::{ShellError, ShellReply, ShellRequest};

pub fn status(request: ShellRequest) -> Result<ShellReply, ShellError> {
    if request.version != 1 {
        return Err(ShellError::UnsupportedVersion {
            received: request.version,
        });
    }

    Ok(ShellReply {
        version: 1,
        application: String::from("stellar-desktop"),
        ready: true,
    })
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

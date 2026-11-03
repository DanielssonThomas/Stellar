use std::{
    io,
    process::{ChildStdin, ChildStdout, Command, ExitStatus},
};

pub(super) struct OwnedChild {
    #[cfg(windows)]
    inner: Box<dyn process_wrap::std::ChildWrapper>,
    #[cfg(not(windows))]
    inner: std::process::Child,
    pub(super) stdin: Option<ChildStdin>,
    pub(super) stdout: Option<ChildStdout>,
}

impl OwnedChild {
    pub(super) fn spawn(command: Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use process_wrap::std::{CommandWrap, CreationFlags, JobObject};
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;
            // Assign the suspended launcher before it can spawn the actual Python interpreter.
            let mut inner = CommandWrap::from(command)
                .wrap(CreationFlags(CREATE_NO_WINDOW))
                .wrap(JobObject)
                .spawn()?;
            let stdin = inner.stdin().take();
            let stdout = inner.stdout().take();
            Ok(Self {
                inner,
                stdin,
                stdout,
            })
        }
        #[cfg(not(windows))]
        {
            let mut command = command;
            let mut inner = command.spawn()?;
            let stdin = inner.stdin.take();
            let stdout = inner.stdout.take();
            Ok(Self {
                inner,
                stdin,
                stdout,
            })
        }
    }

    #[cfg(test)]
    pub(super) fn id(&self) -> u32 {
        self.inner.id()
    }
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }
    pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
        self.inner.wait()
    }
    pub(super) fn kill(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            self.inner.start_kill()
        }
        #[cfg(not(windows))]
        {
            self.inner.kill()
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}

#[cfg(all(test, windows))]
#[path = "owned_child_tests.rs"]
mod tests;

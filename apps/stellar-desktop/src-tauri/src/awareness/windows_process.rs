#![allow(unsafe_code)]

use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_core::{Owned, PWSTR};

pub(super) fn basename(process_id: u32) -> Result<String, ()> {
    if process_id == 0 {
        return Err(());
    }
    // OpenProcess returns an exclusively owned real handle; inheritance is disabled.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(|_| ())?;
    let process = unsafe { Owned::new(process) };
    let mut path = vec![0u16; 32_768];
    let mut length = u32::try_from(path.len()).map_err(|_| ())?;
    // The writable buffer and in/out character count remain alive for this synchronous call.
    unsafe {
        QueryFullProcessImageNameW(
            *process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(|_| ())?;
    let length = usize::try_from(length).map_err(|_| ())?;
    if length == 0 || length >= path.len() {
        return Err(());
    }
    let path = String::from_utf16(&path[..length]).map_err(|_| ())?;
    let name = path
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .ok_or(())?;
    Ok(name.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_returns_only_its_basename_with_limited_query_access() {
        let name = basename(std::process::id()).unwrap();
        let executable = std::env::current_exe().unwrap();
        assert_eq!(name, executable.file_name().unwrap().to_string_lossy());
        assert!(!name.contains(['\\', '/']));
    }

    #[test]
    fn inaccessible_or_invalid_process_identity_is_unavailable() {
        assert!(basename(0).is_err());
        assert!(basename(u32::MAX).is_err());
    }
}

use super::*;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;

fn assert_gone(pid: u32) {
    let status = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
        &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}")])
        .creation_flags(0x08000000).status().unwrap();
    assert!(status.success(), "Owned descendant survived cancellation");
}

#[test]
fn termination_owns_descendants_even_after_the_launcher_exits() {
    for exit_parent in [true, false] {
        let mut command = Command::new("python");
        command.args(["-I", "-u", "-c", &format!(r#"
import subprocess,sys,time
child=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(child.pid,flush=True)
if not {exit_parent}: time.sleep(30)
"#, exit_parent=if exit_parent {"True"} else {"False"})]);
        crate::speech::process::configure(&mut command);
        let mut child = OwnedChild::spawn(command).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let descendant: u32 = line.trim().parse().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_gone(descendant);
    }
}

#[test]
fn dropping_an_owned_group_terminates_its_descendants() {
    let mut command = Command::new("python");
    command.args(["-I", "-u", "-c", "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid,flush=True); time.sleep(30)"]);
    crate::speech::process::configure(&mut command);
    let mut child = OwnedChild::spawn(command).unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let descendant = line.trim().parse().unwrap();
    drop(child);
    assert_gone(descendant);
}

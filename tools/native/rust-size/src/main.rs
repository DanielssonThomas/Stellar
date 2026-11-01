#![forbid(unsafe_code)]

mod policy;

use std::{env, fs, path::Path, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::args().nth(1).ok_or("Workspace root required")?;
    let root = Path::new(&root);
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "*.rs",
        ])
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        return Err("Cannot enumerate repository Rust sources".into());
    }
    let document = fs::read_to_string(root.join("docs/architecture/rust-tauri.md"))?;
    let exceptions = policy::exceptions(&document)?;
    let mut paths: Vec<&str> = std::str::from_utf8(&output.stdout)?
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    for exception in &exceptions {
        if !paths.contains(&exception.path.as_str()) {
            return Err(format!("Exception names missing source: {}", exception.path).into());
        }
    }
    for path in paths {
        let source = fs::read_to_string(root.join(path))?;
        let counts = policy::count(path, &source)?;
        for (category, count) in [("production", counts.0), ("test", counts.1)] {
            policy::validate(path, category, count, &exceptions)?;
            println!(
                "{path}: {category}={count}{}",
                if count >= 300 {
                    " (decomposition review required)"
                } else {
                    ""
                }
            );
        }
    }
    Ok(())
}

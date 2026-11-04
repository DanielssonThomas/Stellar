use super::*;

#[test]
fn display_selection_prefers_current_view_and_never_substitutes_an_explicit_target() {
    let mut displays = vec![
        WorkspaceDisplay {
            id: "primary".into(),
            name: "Left".into(),
            width: 1920,
            height: 1080,
            primary: true,
            foreground: false,
        },
        WorkspaceDisplay {
            id: "secondary".into(),
            name: "Right".into(),
            width: 3840,
            height: 2160,
            primary: false,
            foreground: true,
        },
    ];
    assert_eq!(select(&displays, None).unwrap().id, "secondary");
    assert_eq!(select(&displays, Some("primary")).unwrap().id, "primary");
    assert!(select(&displays, Some("disconnected")).is_none());
    displays[1].foreground = false;
    assert_eq!(select(&displays, None).unwrap().id, "primary");
    assert!(select(&[], None).is_none());
}

#[test]
#[ignore = "Explicit live PC screenshot qualification; writes only to the supplied new evidence directory"]
fn qualify_visible_pc_capture() {
    use std::io::Write;
    let directory = std::env::var_os("STELLAR_SCREEN_CAPTURE_EVIDENCE")
        .map(std::path::PathBuf::from)
        .expect("explicit evidence directory");
    assert!(directory.is_dir());
    let before = Window::foreground().unwrap();
    let owner = before.process_id().unwrap();
    assert_ne!(
        owner,
        std::process::id(),
        "qualification must capture an external application"
    );
    let displays = list().unwrap();
    assert!(!displays.is_empty());
    let mut captures = vec![
        ("monitor.png".to_owned(), display(None).unwrap()),
        ("foreground.png".to_owned(), foreground().unwrap()),
    ];
    for (index, monitor) in displays.iter().enumerate() {
        captures.push((
            format!("display-{index}.png"),
            display(Some(&monitor.id)).unwrap(),
        ));
    }
    assert!(display(Some("disconnected-test-display")).is_err());
    for (name, bytes) in captures {
        assert!(bytes.len() <= super::super::MAX_IMAGE_BYTES);
        let image = ::image::load_from_memory(&bytes).unwrap();
        assert!(image.width() > 100 && image.height() > 100);
        assert!(image.width() <= 4096 && image.height() <= 4096);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(name))
            .unwrap()
            .write_all(&bytes)
            .unwrap();
    }
    assert_eq!(
        Window::foreground().unwrap(),
        before,
        "capture must not move focus"
    );
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("displays.json"))
        .unwrap()
        .write_all(serde_json::to_string_pretty(&displays).unwrap().as_bytes())
        .unwrap();
}

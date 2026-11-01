use super::*;

#[test]
fn physical_lines_include_comments_and_blank_lines() {
    let source = format!("fn main() {{}}\n{}", "// comment\n\n".repeat(250));
    assert_eq!(count("src/main.rs", &source).unwrap(), (501, 0));
}

#[test]
fn test_only_items_are_parsed_without_confusing_strings_or_nested_braces() {
    let source = "const TEXT: &str = r#\"#[cfg(test)] { }\"#;\n#[cfg(test)]\nmod cases {\n // counted\n fn test() { let _ = \"}\"; }\n}\n";
    assert_eq!(count("src/main.rs", source).unwrap(), (1, 5));
}

#[test]
fn ambiguous_conditions_count_as_production() {
    assert_eq!(
        count(
            "src/main.rs",
            "#[cfg(any(test, feature = \"x\"))]\nfn case() {}\n"
        )
        .unwrap(),
        (2, 0)
    );
    assert!(count("src/main.rs", "fn malformed(").is_err());
}

#[test]
fn associated_test_items_and_mixed_physical_lines_are_separated() {
    let source =
        "struct Host;\nimpl Host {\n #[cfg(test)]\n fn helper() {}\n fn production() {}\n}\n";
    assert_eq!(count("src/host.rs", source).unwrap(), (4, 2));
    assert_eq!(
        count("src/host.rs", "fn prod() {} #[cfg(test)] fn case() {}\n").unwrap(),
        (1, 0)
    );
    assert_eq!(
        count("src/host.rs", "#[cfg(test)] fn case() {} fn prod() {}\n").unwrap(),
        (1, 0)
    );
}

#[test]
fn dedicated_test_files_are_wholly_tests() {
    assert_eq!(
        count("src/policy_tests.rs", "// comment\n\nfn case() {}\n").unwrap(),
        (0, 3)
    );
    assert_eq!(
        count("tests/integration.rs", "fn case() {}\n").unwrap(),
        (0, 1)
    );
}

#[test]
fn thresholds_apply_to_both_categories() {
    for category in ["production", "test"] {
        for lines in [299, 300, 500] {
            assert!(validate("src/a.rs", category, lines, &[]).is_ok());
        }
        assert!(validate("src/a.rs", category, 501, &[]).is_err());
    }
}

fn document(json: &str) -> String {
    format!(
        "<!-- rust-size-exceptions:start -->\n```json\n{json}\n```\n<!-- rust-size-exceptions:end -->"
    )
}

#[test]
fn registry_rejects_blanket_exclusions_and_unverifiable_metadata() {
    assert!(exceptions(&document("[]")).is_ok());
    assert!(exceptions(&document("[]").replace('\n', "\r\n")).is_ok());
    assert!(exceptions("No registry").is_err());
    let valid = r#"[{"path":"src/a.rs","category":"production","ceiling":550,"reason":"cohesive","alternatives":"reviewed extraction","authorization":"https://github.com/DanielssonThomas/Stellar/issues/177","reassess_by":"2099-01-01"}]"#;
    let entries = exceptions(&document(valid)).unwrap();
    assert!(validate("src/a.rs", "production", 550, &entries).is_ok());
    assert!(validate("src/a.rs", "production", 551, &entries).is_err());
    assert!(validate("src/a.rs", "test", 501, &entries).is_err());
    assert!(validate("src/b.rs", "production", 501, &entries).is_err());
    for invalid in [
        valid.replace("src/a.rs", "src/*.rs"),
        valid.replace("2099", "2020"),
        valid.replace("550", "500"),
        valid.replace("cohesive", ""),
        valid.replace("2099-01-01", "2099-02-30"),
        valid.replace("issues/177", "issues/"),
        valid.replace("src/a.rs", "../a.rs"),
        valid.replace("\"ceiling\":550", "\"ceiling\":550,\"exclude\":true"),
    ] {
        assert!(exceptions(&document(&invalid)).is_err());
    }
}

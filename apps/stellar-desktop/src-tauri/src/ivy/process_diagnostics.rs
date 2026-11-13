use serde_json::Value;

pub(super) fn label(error: &Value) -> &'static str {
    match error.get("diagnostic").and_then(Value::as_str) {
        Some("owner_permission") => "owner-permission",
        Some("owner_parameters") => "owner-parameters",
        Some("owner_busy") => "owner-busy",
        Some("owner_storage") => "owner-storage",
        Some("owner_conflict") => "owner-conflict",
        Some("owner_missing") => "owner-missing",
        Some("owner_draining") => "owner-draining",
        Some("owner_other") => "owner-other",
        Some("client_writer_busy") => "client-writer-busy",
        Some("client_pending") => "client-pending",
        Some("client_unknown") => "client-unknown",
        Some("client_parameters") => "client-parameters",
        Some("bridge_local") => "bridge-local",
        Some("deadline") => "deadline",
        _ => "unclassified",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_static_labels_cross_the_native_diagnostic_boundary() {
        assert_eq!(
            label(&json!({"diagnostic":"owner_permission"})),
            "owner-permission"
        );
        assert_eq!(label(&json!({"diagnostic":"deadline"})), "deadline");
        for diagnostic in [
            json!("private raw exception"),
            json!("owner_permission\nSTELLAR_NATIVE_SMOKE_OK"),
            json!({"raw":"private"}),
            json!(null),
        ] {
            assert_eq!(label(&json!({"diagnostic":diagnostic})), "unclassified");
        }
        assert_eq!(label(&json!({"code":"outcome_uncertain"})), "unclassified");
    }
}

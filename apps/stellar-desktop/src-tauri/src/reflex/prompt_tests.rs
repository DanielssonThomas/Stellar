use super::{contracts::*, prompt};

fn request() -> ReflexRequest {
    ReflexRequest {
        version: 1,
        input_id: "turn-1".into(),
        text: "skip this garbage".into(),
        mode: ReflexMode::Playful,
        context: "{}".into(),
        history: vec![],
        actions: vec![ReflexChoice {
            id: "media.next".into(),
            description: "Next track".into(),
        }],
    }
}

#[test]
fn constrained_output_disables_thinking_and_limits_actions() {
    let r = request();
    let p = prompt::payload(&r);
    assert_eq!(p["chat_template_kwargs"]["enable_thinking"], false);
    assert_eq!(p["max_tokens"], 160);
    assert_eq!(
        p["response_format"]["schema"]["oneOf"][1]["properties"]["action_id"]["enum"],
        serde_json::json!(["media.next"])
    );
    assert!(prompt::valid_request(&r));
}

#[test]
fn rejects_unknown_actions_tool_calls_and_premature_or_long_replies() {
    let r = request();
    for content in [
        r#"{"route":"action","action_id":"shell.run","reply":"Done."}"#,
        r#"{"route":"clarify","action_id":"media.next","reply":"Which one?"}"#,
        r#"{"route":"action","action_id":"media.next","reply":"one two three four five six seven eight nine ten eleven twelve"}"#,
    ] {
        let body =
            serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]});
        assert!(prompt::decode(body.to_string().as_bytes(), &r).is_none());
    }
    let body = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":r#"{"route":"action","action_id":"media.next","reply":"That one had it coming."}"#}}]});
    assert!(prompt::decode(body.to_string().as_bytes(), &r).is_some());
    let mut thinking = body.clone();
    thinking["choices"][0]["message"]["reasoning_content"] = "hidden reasoning".into();
    assert!(prompt::decode(thinking.to_string().as_bytes(), &r).is_none());
    for reason in ["length", "tool_calls"] {
        let mut bad = body.clone();
        bad["choices"][0]["finish_reason"] = reason.into();
        assert!(prompt::decode(bad.to_string().as_bytes(), &r).is_none());
    }
}

#[test]
fn rejects_duplicate_capabilities_and_oversized_context() {
    let mut r = request();
    r.actions.push(r.actions[0].clone());
    assert!(!prompt::valid_request(&r));
    r.actions.pop();
    r.context = "x".repeat(4097);
    assert!(!prompt::valid_request(&r));
}

#[test]
fn questions_and_explicit_negations_cannot_select_mutations() {
    for text in [
        "What's the current volume?",
        "Ivy, how loud is it?",
        "Don't skip this song.",
        "I said pause earlier, but don't pause now.",
        "Ivy! never skip this song",
        "Ivy: keep playing",
        "do\nnot pause",
    ] {
        let mut r = request();
        r.text = text.into();
        let body = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":r#"{"route":"action","action_id":"media.next","reply":"Done."}"#}}]});
        assert!(prompt::decode(body.to_string().as_bytes(), &r).is_none());
        assert!(
            prompt::payload(&r)["response_format"]["schema"]["oneOf"]
                .as_array()
                .unwrap()
                .iter()
                .all(|variant| variant["properties"]["action_id"]["enum"]
                    .as_array()
                    .is_none_or(|ids| !ids.contains(&serde_json::json!("media.next"))))
        );
    }
}

#[test]
fn higher_risk_work_never_reaches_probabilistic_action_selection() {
    for text in [
        "Delete all project files",
        "Push my code to main",
        "Install another music player",
        "Buy that album",
    ] {
        let mut r = request();
        r.text = text.into();
        let plan = super::admission::delegation(&r).unwrap();
        assert_eq!(plan.route, ReflexRoute::Hermes);
        assert!(plan.action_id.is_none());
    }
    let mut r = request();
    r.text = "Ivy, this song is terrible".into();
    assert!(super::admission::delegation(&r).is_none());
    r.text = "Close the Files pane".into();
    r.actions.push(ReflexChoice {
        id: "pane.0.close".into(),
        description: "Close Files pane".into(),
    });
    assert!(super::admission::delegation(&r).is_none());
}

#[test]
fn layout_without_a_selected_or_named_target_can_only_clarify() {
    for text in [
        "Close that thing",
        "Move that pane over there",
        "Resize it to the right size",
        "Move that pane left",
        "close it",
        "close that",
    ] {
        let mut r = request();
        r.text = text.into();
        r.context = r#"{"workspace":[{"title":"Notes","selected":false},{"title":"Workflow","selected":false}]}"#.into();
        r.actions.push(ReflexChoice {
            id: "pane.0.close".into(),
            description: "Close Notes pane".into(),
        });
        let schema = prompt::payload(&r)["response_format"]["schema"].clone();
        assert_eq!(schema["oneOf"].as_array().unwrap().len(), 1);
        assert_eq!(
            schema["oneOf"][0]["properties"]["route"]["enum"],
            serde_json::json!(["clarify"])
        );
    }
}

#[test]
fn missing_player_never_substitutes_volume_or_layout_for_playback() {
    let mut r = request();
    r.text = "Put some music on".into();
    r.context = r#"{"media":{"player":null,"volume":50},"workspace":[]}"#.into();
    r.actions = vec![
        ReflexChoice {
            id: "media.volume_up".into(),
            description: "Raise volume".into(),
        },
        ReflexChoice {
            id: "view.session".into(),
            description: "Open session".into(),
        },
    ];
    let schema = prompt::payload(&r)["response_format"]["schema"].clone();
    assert_eq!(schema["oneOf"].as_array().unwrap().len(), 1);
    assert_eq!(
        schema["oneOf"][0]["properties"]["route"]["enum"],
        serde_json::json!(["clarify"])
    );
}

#[test]
fn lowering_music_keeps_volume_authority_without_resuming_playback() {
    let mut r = request();
    r.text = "Can you lower the music a notch?".into();
    r.actions.push(ReflexChoice {
        id: "media.volume_down".into(),
        description: "Lower volume".into(),
    });
    let schema = prompt::payload(&r)["response_format"]["schema"].clone();
    assert_eq!(
        schema["oneOf"][1]["properties"]["action_id"]["enum"],
        serde_json::json!(["media.volume_down"])
    );
}

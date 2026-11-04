use super::{
    admission,
    contracts::*,
    scope::{self, Scope},
};

fn request(text: &str) -> ReflexRequest {
    ReflexRequest {version: 1, input_id: "route-test".into(), text: text.into(),
      mode: ReflexMode::Professional, history: vec![],
      context: r#"{"workspace":[{"title":"Notes","selected":true},{"title":"Workflow","selected":false}],"media":{"player":"Fixture Player"}}"#.into(),
      actions: vec![ReflexChoice{id:"view.workflow".into(),description:"Open workflow view".into()},
        ReflexChoice{id:"media.inspect".into(),description:"Inspect playback".into()}]}
}

#[test]
fn substantive_and_social_requests_bypass_local_reasoning_and_all_local_actions() {
    for text in [
        "Please show me my latest github issue",
        "Ivy, how are we doing today?",
        "How are you?",
        "How's our project going?",
        "Tell me about your day",
        "Hello Ivy",
        "What's the weather?",
        "What's next on my calendar?",
        "Can you find my newest issue?",
        "Open the GitHub page for my latest issue",
        "Show my GitHub issue in a new pane",
        "Show the latest workflow run",
        "Tell me our session history",
        "Why is the music paused?",
        "Explain how to skip a track",
        "Can you teach me how music playback works?",
        "What song won a Grammy?",
        "Which song is best for focus?",
        "How does volume affect hearing?",
        "I want to discuss music",
        "Play football",
        "Turn down that job offer",
        "Tell me a joke",
        "Pause music and show my latest issue",
        "Close Notes and mute the speakers",
        "Help me prepare for my next interview",
        "Show previous messages",
        "Move that meeting to Friday",
        "Help me focus on that task",
        "Mute Bob on the call",
        "Turn it down in my essay",
        "Show a workflow presentation about our release",
        "Next week let's play a song at the wedding",
    ] {
        let r = request(text);
        assert_eq!(
            admission::delegation(&r).unwrap().route,
            ReflexRoute::Hermes,
            "{text}"
        );
        assert!(admission::eligible(&r).is_empty(), "{text}");
        assert!(!super::reflex_route(r).local, "{text}");
    }
}

#[test]
fn supported_families_never_gain_unrelated_capabilities() {
    for (text, family) in [
        ("Ivy, this song is terrible", Scope::Transport),
        ("Skip this garbage", Scope::Transport),
        ("Turn it down a little", Scope::Volume),
        ("Could you lower the music a notch?", Scope::Volume),
        ("What's playing right now?", Scope::PlaybackState),
        ("What player is active?", Scope::PlaybackState),
        ("Could you close that thing?", Scope::Pane),
        ("Focus Notes", Scope::Pane),
        ("Open a new workflow view", Scope::View),
        ("Restore the previous layout", Scope::Layout),
        ("Be more playful", Scope::Tone),
    ] {
        let r = request(text);
        assert_eq!(scope::classify(&r), Some(family), "{text}");
        assert!(admission::delegation(&r).is_none(), "{text}");
        if family != Scope::PlaybackState {
            assert!(!scope::allows(family, "media.inspect"), "{text}");
        }
        if family != Scope::View {
            assert!(!scope::allows(family, "view.workflow"), "{text}");
        }
    }
}

#[test]
fn preflight_fails_closed_on_invalid_wire_requests() {
    let mut r = request("Skip this song");
    r.version = 2;
    assert!(!super::reflex_route(r).local);
}

#[test]
fn corpus_keeps_clear_local_actions_and_delegates_external_requests() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../libs/services/desktop-adapter/fixtures/reflex-evaluation.json"
    ))
    .unwrap();
    let mut failures = vec![];
    for row in corpus["cases"].as_array().unwrap() {
        let expected = &row["expected"];
        if expected["route"] == "clarify" {
            continue;
        }
        let scenario = &corpus["contexts"][row["scenario"].as_str().unwrap()];
        let mut r = request(row["text"].as_str().unwrap());
        r.context = scenario["context"].to_string();
        r.actions = serde_json::from_value(scenario["actions"].clone()).unwrap();
        r.history =
            serde_json::from_value(row.get("history").cloned().unwrap_or(serde_json::json!([])))
                .unwrap();
        if expected["route"] == "hermes" {
            assert!(admission::delegation(&r).is_some(), "{}", r.text);
            assert!(admission::eligible(&r).is_empty(), "{}", r.text);
        } else {
            if admission::delegation(&r).is_some()
                || !admission::eligible(&r)
                    .iter()
                    .any(|a| a.id == expected["action_id"])
            {
                failures.push(r.text);
            }
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}

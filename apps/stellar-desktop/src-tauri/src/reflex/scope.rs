use super::contracts::ReflexRequest;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Scope {
    Transport,
    Volume,
    PlaybackState,
    Pane,
    Layout,
    View,
    Tone,
    AmbiguousPane,
}

pub(super) use super::scope_text::text;
use super::scope_text::{command_words, playback_question};

pub(super) fn classify(r: &ReflexRequest) -> Option<Scope> {
    let text = text(&r.text);
    let words: Vec<_> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |items: &[&str]| items.iter().any(|item| words.contains(item));
    if has(&[
        "and",
        "then",
        "discuss",
        "teach",
        "learn",
        "understand",
        "compare",
        "analyze",
        "opinion",
    ]) {
        return None;
    }
    let question = [
        "what ", "what's ", "which ", "how ", "how's ", "is ", "are ", "tell me ", "check ",
        "why ", "who ", "when ", "where ",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix));
    if question {
        return playback_question(&words).then_some(Scope::PlaybackState);
    }

    let context = serde_json::from_str::<Value>(&r.context).unwrap_or(Value::Null);
    let panes = context["workspace"].as_array();
    let clean = words.join(" ");
    let named = panes.is_some_and(|panes| {
        panes
            .iter()
            .filter_map(|p| p["title"].as_str())
            .any(|title| {
                let title = title.to_lowercase();
                title.len() >= 2 && format!(" {clean} ").contains(&format!(" {title} "))
            })
    });
    let pane = has(&["pane", "panes", "panel", "panels"]) || named;
    if has(&["professional", "professionally", "playful"])
        && (has(&["mode", "tone", "be", "speak", "talk", "switch", "sound"]) || words.len() <= 4)
    {
        return command_words(&words, "tone", r).then_some(Scope::Tone);
    }
    if has(&["layout", "arrangement"]) && has(&["restore", "undo", "back", "previous"])
        || has(&["panes"]) && has(&["back"])
    {
        return command_words(&words, "pane", r).then_some(Scope::Layout);
    }
    if has(&["session", "workflow"])
        && has(&["view", "presentation", "panel"])
        && has(&["open", "show"])
    {
        return command_words(&words, "pane", r).then_some(Scope::View);
    }
    if (pane || (panes.is_some_and(|p| !p.is_empty()) && has(&["it", "that", "thing", "these"])))
        && has(&[
            "close", "dismiss", "focus", "select", "minimize", "hide", "maximize", "expand",
            "resize", "bigger", "larger", "half", "move", "swap", "put", "switch", "fill",
            "occupy", "restore",
        ])
        && command_words(&words, "pane", r)
    {
        return Some(Scope::Pane);
    }
    if has(&["pane", "panel"]) && has(&["thing", "do"]) {
        return command_words(&words, "pane", r).then_some(Scope::AmbiguousPane);
    }
    let volume = (has(&["mute", "muted", "unmute", "louder", "quieter", "silence"])
        || has(&["volume", "sound", "audio", "speakers", "music"])
            && has(&[
                "lower", "raise", "reduce", "increase", "decrease", "drop", "less", "more", "up",
                "down", "bump", "boost", "restore",
            ])
        || has(&["turn", "dial"]) && has(&["it"]) && has(&["up", "down"]))
        || has(&["sound", "audio", "speakers"]) && has(&["back", "again", "restore"]);
    let transport = words.iter().all(|word| ["play", "please"].contains(word))
        || (text.contains("one before this") && has(&["back"]))
        || has(&["skip", "pause", "resume", "unpause", "next", "previous"])
        || has(&["music", "song", "track", "playback", "player", "playing"])
            && has(&[
                "play", "hold", "freeze", "continue", "start", "on", "back", "before", "last",
                "enough", "sick", "terrible", "garbage", "hate", "awful", "going", "lose", "carry",
            ]);
    if volume && transport {
        return None;
    }
    if volume {
        return command_words(&words, "volume", r).then_some(Scope::Volume);
    }
    if transport {
        let target = has(&[
            "music", "song", "track", "playback", "player", "playing", "it", "this", "garbage",
            "next", "previous",
        ]);
        let bare = words.iter().all(|w| {
            [
                "play", "pause", "resume", "unpause", "skip", "please", "can", "could", "you",
                "we", "hit", "next", "previous",
            ]
            .contains(w)
        });
        if target || bare || text.contains("one before this") {
            return command_words(&words, "media", r).then_some(Scope::Transport);
        }
    }
    // A short answer may resolve the immediately preceding local pane clarification.
    let positional = panes.is_some_and(|panes| !panes.is_empty())
        && has(&["left", "right", "leftmost", "rightmost"])
        && words.iter().all(|word| {
            [
                "the",
                "one",
                "pane",
                "panel",
                "on",
                "left",
                "right",
                "leftmost",
                "rightmost",
            ]
            .contains(word)
        });
    if (named || positional)
        && words.len() <= 8
        && r.history.last().is_some_and(|row| {
            let Ok(prior) = serde_json::from_str::<Value>(row) else {
                return false;
            };
            let user = text_from_history(&prior);
            let prior_words: Vec<_> = user
                .split(|c: char| !c.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .collect();
            prior["ivy"]
                .as_str()
                .is_some_and(|reply| reply.ends_with('?'))
                && command_words(&prior_words, "pane", r)
                && [
                    "close", "dismiss", "focus", "select", "move", "swap", "resize", "bigger",
                    "minimize", "maximize",
                ]
                .iter()
                .any(|verb| prior_words.contains(verb))
        })
    {
        return command_words(&words, "pane", r).then_some(Scope::Pane);
    }
    None
}

fn text_from_history(prior: &Value) -> String {
    text(prior["user"].as_str().unwrap_or_default())
}

pub(super) fn allows(scope: Scope, id: &str) -> bool {
    match scope {
        Scope::Transport => {
            ["media.play", "media.pause", "media.next", "media.previous"].contains(&id)
        }
        Scope::Volume => [
            "media.volume_up",
            "media.volume_down",
            "media.mute",
            "media.unmute",
        ]
        .contains(&id),
        Scope::PlaybackState => id == "media.inspect",
        Scope::Pane => id.starts_with("pane."),
        Scope::Layout => id == "layout.restore",
        Scope::View => id.starts_with("view."),
        Scope::Tone => id.starts_with("tone."),
        Scope::AmbiguousPane => false,
    }
}

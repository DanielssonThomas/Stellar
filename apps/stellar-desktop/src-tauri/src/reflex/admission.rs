use super::contracts::*;
use serde_json::Value;

pub fn delegation(request: &ReflexRequest) -> Option<ReflexPlan> {
    let words: Vec<_> = request
        .text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    let outside_scope = [
        "research",
        "refactor",
        "delete",
        "shell",
        "buy",
        "book",
        "email",
        "password",
        "install",
        "subscribe",
        "code",
        "download",
        "ci",
        "calculate",
        "story",
        "explain",
        "calendar",
        "summarize",
        "files",
        "executable",
        "write",
        "coding",
        "parser",
        "program",
    ];
    let known_pane = words.iter().any(|w| w == "pane")
        && request.actions.iter().any(|a| {
            a.id.starts_with("pane.")
                && ["files", "research", "code"].iter().any(|name| {
                    a.description.to_lowercase().contains(name)
                        && words.iter().any(|word| word == name)
                })
        });
    words
        .iter()
        .any(|word| {
            outside_scope.contains(&word.as_str())
                && !(known_pane && ["files", "research", "code"].contains(&word.as_str()))
        })
        .then(|| ReflexPlan {
            route: ReflexRoute::Hermes,
            action_id: None,
            reply: "Let me take a closer look.".into(),
        })
}

// Conservative admission guard: informational questions and explicit negations
// must not gain mutation authority from a probabilistic interpretation.
pub fn eligible(r: &ReflexRequest) -> Vec<&ReflexChoice> {
    let normalized = r
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .replace('’', "'");
    let punctuation = |c: char| c.is_whitespace() || ",.:;!?".contains(c);
    let text = ["ivy", "i.v"]
        .iter()
        .find_map(|wake| {
            normalized
                .strip_prefix(wake)
                .filter(|tail| tail.is_empty() || tail.starts_with(punctuation))
        })
        .unwrap_or(&normalized)
        .trim_start_matches(punctuation);
    let negated = text.contains("don't ")
        || text.contains("do not ")
        || text.contains("not asking")
        || [
            "don't ",
            "do not ",
            "never ",
            "no, ",
            "leave ",
            "keep ",
            "i'm quoting ",
            "if i ",
            "i said ",
        ]
        .iter()
        .any(|p| text.starts_with(p));
    let question = [
        "what ", "what's ", "which ", "how ", "is ", "are ", "tell me ", "check ",
    ]
    .iter()
    .any(|p| text.starts_with(p));
    let media = [
        "music", "song", "track", "playback", "player", "volume", "speakers", "audio", "sound",
        "mute", "unmute", "louder", "quieter", "pause", "resume", "unpause",
    ]
    .iter()
    .any(|word| {
        text.split(|c: char| !c.is_alphanumeric())
            .any(|part| part == *word)
    });
    let media = media
        && !text
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word == "pane" || word == "panel");
    let ambiguous = !media && ambiguous_pane(r, text);
    let words: Vec<_> = text.split(|c: char| !c.is_alphanumeric()).collect();
    let transport_verb = [
        "play", "resume", "unpause", "pause", "skip", "next", "previous",
    ]
    .iter()
    .any(|word| words.contains(word));
    let volume = [
        "volume", "sound", "audio", "speakers", "mute", "unmute", "louder", "quieter", "down",
        "up", "lower", "raise", "reduce", "increase", "loud", "quiet",
    ]
    .iter()
    .any(|word| words.contains(word));
    let transport_noun = ["music", "song", "track", "playback", "player"]
        .iter()
        .any(|word| words.contains(word));
    let needs_player = media && (transport_verb || (transport_noun && !volume));
    let missing_player = serde_json::from_str::<Value>(&r.context)
        .ok()
        .is_some_and(|context| {
            context.get("media").is_some_and(|state| {
                state.is_null() || state.get("player").is_some_and(Value::is_null)
            })
        });
    r.actions
        .iter()
        .filter(|a| {
            !negated
                && !ambiguous
                && !(needs_player && missing_player && !question)
                && (!media || a.id.starts_with("media."))
                && (!media
                    || !volume
                    || transport_verb
                    || [
                        "media.volume_up",
                        "media.volume_down",
                        "media.mute",
                        "media.unmute",
                        "media.inspect",
                    ]
                    .contains(&a.id.as_str()))
                && (!needs_player
                    || [
                        "media.play",
                        "media.pause",
                        "media.next",
                        "media.previous",
                        "media.inspect",
                    ]
                    .contains(&a.id.as_str()))
                && (!question || a.id == "media.inspect")
        })
        .collect()
}

fn ambiguous_pane(r: &ReflexRequest, text: &str) -> bool {
    let words: Vec<_> = text.split(|c: char| !c.is_alphanumeric()).collect();
    let layout = [
        "move", "put", "pane", "panel", "resize", "bigger", "larger", "thing", "these", "close",
        "focus", "minimize", "maximize", "switch",
    ]
    .iter()
    .any(|w| words.contains(w));
    if layout && (words.contains(&"there") || words.contains(&"somewhere")) {
        return true;
    }
    let Ok(context) = serde_json::from_str::<Value>(&r.context) else {
        return false;
    };
    let Some(panes) = context.get("workspace").and_then(Value::as_array) else {
        return false;
    };
    if !layout || panes.len() < 2 || panes.iter().any(|p| p["selected"].as_bool() == Some(true)) {
        return false;
    }
    let named = panes
        .iter()
        .filter_map(|p| p["title"].as_str())
        .any(|title| !title.is_empty() && text.contains(&title.to_lowercase()));
    let positioned = [
        "left pane",
        "leftmost pane",
        "right pane",
        "rightmost pane",
        "left panel",
        "right panel",
        "pane on the left",
        "pane on the right",
    ]
    .iter()
    .any(|phrase| text.contains(phrase));
    !named && !positioned
}

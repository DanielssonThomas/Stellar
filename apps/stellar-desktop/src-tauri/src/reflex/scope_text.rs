use super::contracts::ReflexRequest;

pub(super) fn text(input: &str) -> String {
    let mut text = input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .replace('’', "'");
    for _ in 0..4 {
        let old = text.clone();
        for prefix in [
            "hey ivy",
            "ivy",
            "i.v",
            "please",
            "can you",
            "could you",
            "would you",
            "can we",
        ] {
            if let Some(tail) = text.strip_prefix(prefix)
                && (tail.is_empty()
                    || tail.starts_with(|c: char| c.is_whitespace() || ",.:;!?".contains(c)))
            {
                text = tail
                    .trim_start_matches(|c: char| c.is_whitespace() || ",.:;!?".contains(c))
                    .to_string();
                break;
            }
        }
        if old == text {
            break;
        }
    }
    text
}

pub(super) fn playback_question(words: &[&str]) -> bool {
    let has = |items: &[&str]| items.iter().any(|item| words.contains(item));
    let allowed = [
        "what",
        "s",
        "which",
        "how",
        "is",
        "are",
        "anything",
        "playing",
        "currently",
        "now",
        "right",
        "the",
        "this",
        "it",
        "song",
        "track",
        "music",
        "player",
        "active",
        "playback",
        "state",
        "current",
        "volume",
        "loud",
        "set",
        "muted",
        "paused",
        "mute",
        "desktop",
        "output",
        "speakers",
        "at",
        "on",
        "we",
        "our",
        "my",
        "tell",
        "me",
        "check",
        "please",
        "any",
    ];
    words.iter().all(|word| allowed.contains(word))
        && (has(&[
            "playing", "volume", "loud", "muted", "paused", "playback", "player",
        ]) || (has(&["song", "track", "music"]) && has(&["this", "current", "we", "state"])))
}

// A positive command vocabulary prevents domain words inside substantive requests
// from granting local authority. Unknown content goes to Hermes unchanged.
pub(super) fn command_words(words: &[&str], family: &str, request: &ReflexRequest) -> bool {
    let common = "a an the this that these those it its is are i m we my our me you your please can could would will let s some one of to for on in into at by with without again now current selected existing new all any";
    let vocabulary = match family {
        "media" => {
            "play pause resume unpause skip next previous track song music playback player playing configured move what not garbage terrible awful hate sick enough lose hold freeze continue start back before last liked go hear take bring hit oops backward stop minute need quiet put get going have carry anything but isn t surviving another second"
        }
        "volume" => {
            "put turn dial take bring boost need playback back down up little bit volume sound audio music speakers desktop system output lower raise reduce increase decrease drop less more notch moderately modest needs bump ten percent 10 ears appreciate slightly make give boost mute muted unmute silence moment no restore changing off undo remove want too loud louder quieter let"
        }
        "pane" => {
            "pane panes panel panels close dismiss focus select minimize hide maximize expand resize bigger larger half quarter three quarters move swap put switch fill occupy restore make give bring full size stage space layout arrangement twenty five fifty seventy percent 25 50 75 right left leftmost rightmost spot over there somewhere else thing do where they were change undo previous back session workflow view presentation notes ivy open show"
        }
        "tone" => "professional professionally playful mode tone be speak talk switch sound more",
        _ => "",
    };
    let context = serde_json::from_str::<serde_json::Value>(&request.context).unwrap_or_default();
    let names = if family == "pane" {
        context["workspace"]
            .as_array()
            .map(|panes| {
                panes
                    .iter()
                    .filter_map(|p| p["title"].as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    words.iter().all(|word| {
        common
            .split_whitespace()
            .chain(vocabulary.split_whitespace())
            .chain(names.split(|c: char| !c.is_alphanumeric()))
            .any(|allowed| word == &allowed)
    })
}

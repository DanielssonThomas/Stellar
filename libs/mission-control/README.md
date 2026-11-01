# ui-templates

This library was generated with [Nx](https://nx.dev).

## Running unit tests

Run `nx test ui-templates` to execute the unit tests.

## Desktop experience

`DesktopExperienceTemplate` is available through the public secondary entry point `@stellar/ui-templates/desktop-experience`. The generated template was moved into that entry point so desktop consumers do not compile the unrelated mission-control screens and their styles. It composes the lower-layer emblem and Stage, exposes loading/error inputs and emits semantic actions; it does not acquire audio or own the interaction state machine. The app supplies state, validated artwork, audio level and status text, and sends typed Stage commands through its public `dispatch` method. The Start/End control retains its DOM identity so a summary can restore keyboard focus.

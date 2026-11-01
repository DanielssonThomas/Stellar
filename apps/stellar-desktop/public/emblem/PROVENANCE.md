# Stellar emblem asset study

This pack is an **unapproved study**, not the final Stellar artwork. It may be used to exercise layer composition, motion and loading behavior. Issue #176 remains incomplete until the visual quality matches the supplied reference and Foreman and Codex inspect the final renders.

## Source and authorship

`assets/stellar-emblem-reference.png` is the user-supplied concept sheet. The interpretation retains two profiles, botanical hair ornaments, gemstone accents, two complete rings and four cardinal ornaments, while omitting dangling earrings as requested in the brief.

Hermes Peon produced `assets/stellar-emblem-peon-draft.svg` from a textual description in one `gpt-6-luna` session on 1 November 2026. The image was not attached: the installed CLI rejected its advertised image option before inference. Session `local-6ca80b2c88cda03137d67616e6cc2961b31e3d22c085bba549d6d1be5d2e422b` reports 3,726 input tokens, 2,592 output tokens, one API call, zero tool calls and subscription-included billing. The complete response was recovered from its existing session record after the host's stream-output limit was reached; no inference retry was used.

Codex rejected the original draft because hair obscured the profiles. `assets/stellar-emblem-study.svg` corrects ordering and reduces broad bright fills; it still lacks the reference's flowing hair, facial character, botanical detail and rich silhouette. These limitations are visible at full size and more pronounced in the dock fixtures. Neither file is approved final art.

## Layer contract

`assets/manifest.json` declares version 1 and status `study`. Twelve transparent SVG layers share the `0 0 512 512` viewBox. Each entry has a stable identifier, relative file path, z-order, anchor and assembled/exploded transforms. The assembled source and layer files are editable SVG. Renderers should preserve these transforms and own their container position separately.

The source contains no script, event handlers, external references, foreign objects or embedded images. Each image should load as an image resource rather than injected markup. Consumers must validate supplied manifests and display their normal asset-error fallback when a layer fails to load. The original reference is provenance, not a runtime layer.

Runtime SVG source plus manifest has a 100 KiB budget, excluding the reference and review fixtures. This is a study budget, not a claim about final artwork fidelity or performance.

After installing the workspace dependencies and Playwright Chromium, run `node libs/stellar-emblem/render-study.mjs` from the repository root. It validates the SVG element/attribute allowlist, rejects active or external content, checks layer IDs and viewBoxes, enforces the source-size budget and recreates the assembled/exploded/dock contact sheet. The current study uses 28,432 bytes across its assembled SVG, manifest and twelve layers. The fixtures show that the rings remain distinguishable at dock sizes but profile and ornament detail does not approach the supplied reference.

## Review status

The bounded Peon attempt did not meet the visual acceptance criteria. Preserve it as capability evidence; do not spend further identical text-only calls or approve a crude substitute to unblock application code. The reusable motion component accepts a supplied manifest independently, so final art refinement does not block its implementation.

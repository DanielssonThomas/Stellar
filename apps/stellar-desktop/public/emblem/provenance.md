# Embedded emblem study

This is the unapproved asset study from [issue #176](https://github.com/DanielssonThomas/Stellar/issues/176). It exercises product composition; final visual qualification is pending. The manifest retains status `study`. The original user reference is preserved as `stellar-emblem-reference.png` and is not rendered as a runtime layer.

Hermes Peon generated the original textual SVG draft in session `local-6ca80b2c88cda03137d67616e6cc2961b31e3d22c085bba549d6d1be5d2e422b` on 1 November 2026 (gpt-6-luna, 3,726 input / 2,592 output tokens, one API call, zero tool calls, included billing). Codex corrected ordering and bright fills and separated twelve SVG layers. The study still lacks the reference's flowing hair, facial character, botanical detail and silhouette fidelity, especially at dock sizes. It is not final artwork.

All layers share a 512×512 canvas and render as image resources, never injected SVG markup. The bundled manifest has stable IDs, relative paths, anchors and assembled/exploded poses. Runtime layers are local SVG resources without scripts or external references. #183 copies them unchanged and reverses no asset transforms; the reusable motion component selects the idle exploded and activity assembled poses.

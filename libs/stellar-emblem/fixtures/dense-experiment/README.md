# Dense exploded emblem experiment

Runtime evidence for [#251](https://github.com/DanielssonThomas/Stellar/issues/251), captured in headless Chromium from the production Angular build at 1100 × 760, DPR 1. `comparison.png` pairs the actual 47-plane exploded and settled assembled views. `mid-assembly.png` freezes the actual camera/layer animations at 500 ms; the menu is open to trigger the manual activity. `returned.png` shows the return to idle after dismissal. These are browser captures, not native Windows acceptance or a performance qualification.

The experiment keeps the same eleven image files, complete main middle frame and exact settled assembly. Hair uses twelve fragments per color and jewelry six. Two secondary rings scatter, and depth gaps compress toward the stack ends. The original raster and assembled preview bytes remain unchanged; exporter and browser pixel comparisons verify registration at full and supported small sizes.

Run `corepack pnpm exec nx run stellar-desktop:serve-static --port=4311` after building, then open `http://localhost:4311`. Use **Experience menu → Start activity** to assemble and **Dismiss** to return. This browser route supports manual visual review without native Ivy or microphone connectivity.

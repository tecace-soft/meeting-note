---
description: Refresh the AI-native docs (prose narrative + decision log) and regenerate the structural regions.
---

Refresh `docs/ai-native/` so it stays an accurate, current entry point for coding agents.

Do the following:

1. Run the deterministic generator to sync the structural regions:
   `node scripts/ai-native-docs/generate.mjs` (or `npm run docs:ai-native`).
   This rewrites only the text between the `<!-- ai-native:auto:START ... -->` / `<!-- ai-native:auto:END -->` markers.
   Never hand-edit inside those regions.

2. Review recent meaningful changes since the docs were last touched (e.g. `git log` since the last edit to `docs/ai-native/`, and the working diff).
   Focus on changes that affect what the product is, how subsystems fit together, or how to work in the repo.

3. Update the PROSE in `docs/ai-native/intro.md` (the narrative and subsystem descriptions) only where reality has changed.
   Keep it concise and accurate; do not invent structure, derive it from the repo.

4. If this change involved a notable decision (a fork in approach, a trade-off, a scope call), prepend a dated entry to `docs/ai-native/decision.md` with a one-line reason each.
   Add a condensed line to the prose section of `docs/ai-native/history.md` only for a genuinely high-level shift; routine commits are already captured in its auto-region.

Rules: each sentence on its own line in these Markdown files; never use em-dashes; do not commit or push unless the user asks.

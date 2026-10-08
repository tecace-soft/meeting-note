# Meeting Note: decisions

Notable decisions and a short reason each, newest first.
This file is entirely prose; append a new entry when a meaningful decision is made (the `/update-docs` command helps).

## 2026-10-08: AI-native documentation automation

- **Layout: `docs/ai-native/` with `intro.md` (entry), `history.md`, `decision.md`.**
  One always-current entry point gives coding agents a clean place to start, instead of scattering context across the many root-level `*_DESIGN.md` files.
  `intro.md` is the root and points out to each subsystem.

- **Hybrid generation: deterministic script for structure, agent-authored prose for narrative.**
  Structure (directory tree, subsystem map, recent git history) is mechanical and goes stale silently, so a script owns it.
  Narrative and rationale need judgment, so an agent writes those.
  The two never collide because the script rewrites only the text between explicit marker comments (`<!-- ai-native:auto:START section=... -->` ... `<!-- ai-native:auto:END -->`).

- **Deterministic generator has no network and no LLM, Node built-ins only.**
  It must be safe to run on every commit without an API key, and it must be idempotent so running it twice produces no diff.

- **Trigger via a committed git pre-commit hook, not cloud CI.**
  A `pre-commit` hook (`.githooks/pre-commit`, enabled with `git config core.hooksPath .githooks`) runs the generator and `git add docs/ai-native` so the regenerated structure rides along with the change automatically.
  Pre-commit (not pre-push) was chosen so the docs are part of the same commit that changed the structure, which keeps history honest and review self-contained.
  The hook never auto-amends and never pushes, and it ignores the generator's exit code so documentation generation can never block a commit.
  A GitHub Action / cloud CI was explicitly rejected: it would need a separate Claude API key for the prose and would not help the deterministic part.

- **Prose trigger is a Claude Code slash command (`/update-docs`), surfaced by a one-line rule in AGENTS.md.**
  The structural regions self-heal through the hook, so the only human/agent step left is refreshing the narrative and this decision log, which is exactly what an agent is good at.

- **Scope: whole repo, one entry doc pointing to subsystems.**
  Out of scope on purpose: no cloud CI, and no deep mobile or supabase-migration docs beyond listing them as subsystems.
  Keeping the scope tight is what makes the entry doc worth reading.

# Meeting Note: how it changed

A readable, condensed history, not a granular changelog.
The prose below is the high-level story; recent commit subjects are not kept here (see the last line).

## The story so far

The product started as a Microsoft-auth web app for audio transcription and Teams chat access, then grew a dedicated Node pipeline (`workflow-server/`) for transcribe + summarize on top of AssemblyAI and Gemini.

From there the work moved up the value chain in a few broad waves:

- Reliability and scale: orphaned-job sweeps on restart, larger uploads and longer recordings, latency work on the summary critical path, and error-handling passes.
- Memory: a personal memory layer that folds action items, collaborators, projects, and topics across meetings, measured by an eval harness before shipping, and then wired into summary generation and an MCP tool.
- Speaker identification: a context-based (not voiceprint) approach, backtested and tuned for within-roster discriminability rather than raw coverage.
- MCP and connectors: the MCP server was merged into the backend process to cut hosting cost, then hardened for spec-correct OAuth / auth so Claude and ChatGPT can connect.
- Private meeting knowledge: policy-gated extraction and durable private delivery of meeting knowledge, with project-scoped RLS tightened on the way.

For the per-commit detail of the most recent work, use `git log`; for deeper design rationale see the `*_DESIGN.md` files at the repo root.

Recent changes live in `git log` and the GitHub merge history, not in this file.
AX-KH node assembly reads git directly (DEC-0023).


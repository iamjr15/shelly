# State Inference Fixtures

These fixtures are safe-to-commit, redacted examples of the terminal/output
shapes Shelly uses for v1 agent-state inference.

- `claude_code_*` fixtures model Claude Code terminal transcript lines after
  terminal sanitization. They intentionally include no prompt text, paths, file
  contents, or command output from a private project.
- `codex_*` fixtures model structured Codex event JSON accepted by the daemon
  and local `shelly hook codex-event` adapter.

Authenticated live captures from real Claude/Codex sessions remain a release
verification activity because they require user accounts and may contain private
workspace content. Any live capture committed here must be redacted first.

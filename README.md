# pair-integrations

Activity bridges that feed the PaiR app (`pai-r`) AI-activity events from harnesses it
has no native hook installers for: **opencode** and **OMP**. Qwen Code has no lifecycle
hook surface (its extensions only package prompts/MCP/commands), so it is not covered.

## Layout

| Path | Installs to |
|---|---|
| `opencode/pair-plugin/plugin.ts` | `~/.config/opencode/plugins/pair.ts` (global) or `<project>/.opencode/plugins/pair.ts` |
| `omp/pair-omp-activity.ts` | `~/.omp/agent/extensions/pair-omp-activity.ts` |
| `test/smoke.ts`, `test/shim/pair` | nowhere — dev-only; `bun test/smoke.ts` |

## How it works

Both bridges shell out to the PaiR CLI (the stable, supported surface) — one
fire-and-forget `pair` process per event, never blocking the harness:

- Tool activity → `pair notify --hook PreToolUse|PostToolUse --ai-name <slot>` with a
  Claude-shaped JSON payload on stdin (the documented classifier path; PreToolUse →
  `claude:tool_start`).
- Lifecycle → `pair notify -t agent_start|agent_stop|permission` (free-form types are
  accepted by pai-r 0.47.0).

Session identity is not the bridge's problem: PaiR resolves it from the terminal
(`PAIR_TERMINAL` → pane map → herdr → tmux → ancestors → project), so events land on
the session that owns the terminal the harness runs in.

### opencode plugin (v2 local-plugin contract)

opencode 2.1.4 loads local plugins via a **default export** and calls `setup(ctx)`;
the documented npm-style named plugin exports and `server()` hooks are never invoked
in v2 run modes (probed first-hand; `paseo-terminal-activity.js` beside the install
uses the same pattern). The plugin subscribes to the v2 event bus
(`ctx.event.subscribe`); payloads live in `event.data`. The tool **name** only arrives
on `session.tool.input.started` (`data.name` + `data.id`) and the **args** on
`session.tool.called` (`data.input` + `data.id`) — joined by tool-call id:

| Bus event | PaiR event |
|---|---|
| `session.execution.started` | `agent_start` toast |
| `session.execution.succeeded` / `failed` / `interrupted` | `agent_stop` toast |
| `permission.asked` | `permission` toast (`data.title`) |
| `session.tool.input.started` + `session.tool.called` (joined) | `PreToolUse` → `claude:tool_start` |
| `session.tool.success` / `session.tool.failed` | `PostToolUse` |

### OMP extension

`~/.omp/agent/extensions/*.ts` with `pi.on(name, handler)` (undocumented surface; the
herdr-managed extension beside it is the other in-tree consumer):

| OMP event | PaiR event |
|---|---|
| `agent_start` | `agent_start` toast |
| `agent_end` (unless `willContinue`) | `agent_stop` toast |
| `tool_approval_requested` | `permission` toast |
| `tool_execution_start` / `tool_execution_end` | `PreToolUse` / `PostToolUse` |

## Gates and knobs

- **Active only when `PAIR_TERMINAL` is set** — i.e. inside a PaiR-managed terminal.
- OMP bridge skips **nested** omp sessions (`OMPCODE=1`): the parent session's extension
  owns the PaiR identity (same rule as herdr's own omp integration).
- `PAIR_NOTIFY=0` — kill switch. **Set this for services**: anything that spawns
  opencode non-interactively under a PaiR terminal (e.g. an orchestrator host) would
  funnel every dispatched session's tool calls into one session's activity feed.
- `PAIR_AI_NAME` — badge label shown in PaiR; must be one of the closed set
  `claude, cursor, codex, gemini, vibe`. Defaults: opencode → `codex`, OMP → `gemini`.

## Known limitations (pai-r 0.47.0)

- All events ride PaiR's `claude:*` notify channel — `--ai-name` only changes the badge,
  not the channel. There is no `opencode`/`omp` channel; ask the PaiR maintainer
  (Laurent Chapin, w3dev.fr) to add them, then just change the default `PAIR_AI_NAME`.
- Observation is one-way: toasts + activity feed only. Cables/inbox typing into these
  harnesses are not wired (that needs the per-agent mod, as Claude Code has).
- The opencode bus does not carry the tool name on `session.tool.called`; if
  `session.tool.input.started` was missed the Pre/PostToolUse payload falls back to
  `tool_name: "tool"`.

## Install

```bash
mkdir -p ~/.config/opencode/plugins
cp opencode/pair-plugin/plugin.ts ~/.config/opencode/plugins/pair.ts
cp omp/pair-omp-activity.ts ~/.omp/agent/extensions/pair-omp-activity.ts
```

The opencode plugin loads on the next `opencode` start; the OMP extension on the next
session start. Revert by deleting the two copies.

## Test

```bash
bun test/smoke.ts
```

Drives both bridges against a PATH-shimmed `pair` (records argv + stdin, atomic
appends) and asserts the event mapping, default badge labels, and all three gates
(nested omp, non-PaiR terminal, kill switch).

Live-verification results, open issues, and the QA manual plan:
[`docs/2026-10-27-handoff-verification.md`](docs/2026-10-27-handoff-verification.md).

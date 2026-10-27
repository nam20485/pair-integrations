# PaiR bridges — verification handoff (2026-10-27)

Audience: devs fixing issues / implementing features, and QA running the manual plan.
Scope: `omp/pair-omp-activity.ts` and `opencode/pair-plugin/plugin.ts` at commit
`807482a` (post-`e37e10f`, docs-only delta). Both installed copies diff-verified
in-sync at test time:

| Bridge | Install target | Sync |
|---|---|---|
| OMP | `~/.omp/agent/extensions/pair-omp-activity.ts` | identical |
| opencode | `~/.config/opencode/plugins/pair.ts` | identical |

Environment: pai-r 0.47.0 (app running, `~/.pair/pair.sock`), herdr session `pair`
(pane `w4:p1`), omp session under a PaiR-managed terminal (`PAIR_TERMINAL=pty-310c5d1c`),
project `swarm-orchestration-service`.

## 1. Verified working — live evidence

| Claim | How observed |
|---|---|
| Gates: enabled on root omp under PaiR terminal | omp worker env has `PAIR_TERMINAL`, no `OMPCODE` → bridge active |
| Gates: nested-omp suppression target case exists | `OMPCODE=1` present in every omp-spawned shell env |
| All 5 `pair notify` shapes accepted | manual invocations acked `{"ok":true}`: `-t agent_start`→`claude:agent_start`, `-t agent_stop`→`claude:agent_stop`, `-t permission`→`claude:permission`, `--hook PreToolUse`→`claude:tool_start`, `--hook PostToolUse`→`claude:tool_end` |
| Tool events fire per tool call | 50 ms `ps` sampler caught extension-spawned `pair notify --hook PreToolUse/PostToolUse --ai-name gemini` around a `read` tool call (no `--json` — extension never passes it) |
| Turn-end lifecycle fires | sampler caught `pair notify -t agent_stop --ai-name gemini -m omp: idle` the moment the omp turn settled |
| herdr parity on same pane | `herdr agent list`: `agent: omp`, `working`→`idle`→`working` across the turn boundary, `state_change_seq` 16→20 |
| Approval payload field names | `event.reason` / `event.toolName` match the in-tree consumer `herdr-omp-agent-state.ts` v10 (`tool_approval_requested` handler, line 408) |
| Shim smoke suite | `bun test/smoke.ts` → 5/5 PASS (mappings, badge defaults `gemini`/`codex`, `willContinue` ignore, all 3 gates) |

Not live-observed (accepted by CLI ack + shared spawn path, but QA should confirm in
the UI): `agent_start` toast at session open, `tool_approval_requested` → permission toast.

## 1b. opencode bridge — live-verified e2e (2026-10-27, second session)

The opencode plugin was the shim-only gap in §4/QA-5; it is now live-verified end-to-end.
Environment: opencode v2.1.4, pair 0.47.0, herdr 0.9.5, PaiR-managed herdr session
`pair` (`PAIR_TERMINAL=pty-310c5d1c`). Method: black-box — a logging shim replaced
`pair` on PATH, isolated `opencode run --standalone` sessions drove a tool-using prompt;
the `permission.asked` probe drove a real `opencode serve` over its HTTP API (see §6b).

| Test | Evidence | Verdict |
|---|---|---|
| Plugin loads (v2 default-export + `setup(ctx)` contract) | server log `loading plugin … /plugins/pair.ts`, zero errors | PASS |
| Lifecycle toasts | shim caught `notify -t agent_start … -m "opencode: working"` then `-t agent_stop … -m "opencode: idle"` | PASS |
| PreToolUse name+args id-join | stdin `{"hook_event_name":"PreToolUse","tool_name":"shell","tool_input":{"command":"echo hello-pair-test"},"cwd":…}` — `session.tool.input.started` → `session.tool.called` join works | PASS |
| PostToolUse | matching hook event; tool ref deleted after | PASS |
| `permission.asked` → permission toast | real server emitted `permission.asked` (verified on `/api/event` SSE); shim caught `notify -t permission --ai-name codex -m "opencode permission: tool"` — **message quality issue, see I5** | PASS (branch fires) |
| Kill switch `PAIR_NOTIFY=0` | zero shim calls | PASS |
| Gate: `PAIR_TERMINAL` unset | zero shim calls (first attempt false-FAILED: the driver shell's own exported `PAIR_TERMINAL` leaked through `env`; re-ran with `env -u`) | PASS |
| `PAIR_AI_NAME=claude` badge | all 4 calls carried `--ai-name claude` | PASS |
| herdr parity on same pane | `herdr agent list`: `agent: opencode`, status `working`, source `herdr:opencode` v13, live session id reported | PASS |
| Real `pair notify` delivery | `pair notify -t agent_start --ai-name codex -m …` → ack `claude:agent_start`, exit 0 | PASS |
| Repo smoke suite | `bun test/smoke.ts` → ALL PASSED (re-run this session) | PASS |

Headless caveat (docs-confirmed): non-interactive clients **auto-decide** approval
requests, so `opencode run` never surfaces an ask — the permission path needs the
serve+API method in §6b (or an interactive TUI session) to exercise.

## 2. Issues to fix

### I1 — HIGH: orchestrator host leaks dispatched-agent activity into the dev's PaiR feed
`swarm-orchestration-service` `src/webhook_receiver/acp_host.py` spawns `opencode acp`
with the full parent env (its own test asserts this: "the full parent env rides along"),
and `grep PAIR_NOTIFY|PAIR_TERMINAL src/` → zero hits. When the service is run
manually from a PaiR-managed terminal (the normal dev setup here), every dispatched
ACP session's opencode inherits `PAIR_TERMINAL`, loads the globally-installed
`~/.config/opencode/plugins/pair.ts`, and funnels all its tool events into the dev's
PaiR activity feed — exactly the case README "Gates and knobs" prescribes
`PAIR_NOTIFY=0` for.

Fix (swarm-orchestration-service): set `PAIR_NOTIFY=0` in the child env at the
`spawn_agent_process` seam (one line + a test asserting the scrub), or in the
deployment unit. Prefer the spawn seam: it protects every run mode.

### I2 — MED: stale "working" badge when an omp session dies or switches mid-turn
The OMP bridge subscribes neither `session_shutdown` nor `session_switch`
(`herdr-omp-agent-state.ts:466` proves `session_shutdown` exists on the same
surface). If omp is killed or the session switches mid-turn, PaiR never receives
`agent_stop` and the badge sticks on working.

Fix: subscribe `session_shutdown` (and `session_switch`) in
`omp/pair-omp-activity.ts`, emit the same `-t agent_stop` call; extend
`test/smoke.ts` (fire the events, assert the extra `agent_stop` calls).

### I3 — LOW: PostToolUse payload carries no outcome
`hookJson` sends `tool_input` only. The Claude PostToolUse shape allows
`tool_response`; pai-r 0.47.0's classifier appears to ignore it, but including
the exit/error status (when the omp event carries one) makes failures
distinguishable the day pai-r grows support. Check the actual
`tool_execution_end` payload for a status field first; if absent, drop this.

### I4 — LOW: pai-r version pin is documentation-only
Headers and README pin behavior to pai-r 0.47.0 (all events on the `claude:*`
channel, closed `--ai-name` set, free-form `-t` types). Nothing fails loudly if a
pai-r upgrade changes `notify` flags. Add a smoke assertion (run the real `pair
notify --json` once when available, assert `ok:true`) or a documented probe
command in README so an upgrade is caught deliberately.

### I5 — MED: opencode permission toast always degrades to "opencode permission: tool"
First-hand against a real v2.1.4 server: the bus event is
`permission.asked` with `data = { id, sessionID, action: "shell", resources: ["echo …"],
save: ["echo *"], source: { type: "tool", … } }` — **there is no `data.title`**. The
plugin's `str(data?.title)` is therefore always undefined and every permission toast
reads the generic fallback `opencode permission: tool` (verified live: the shim caught
exactly that while the real event carried `action: "shell"`, `resources: ["echo perm-probe"]`).
Fix in `opencode/pair-plugin/plugin.ts`: build the message from
`data.action` + `data.resources.join(", ")` (truncate long joins), keep a title fallback
for forward-compat. Extend `test/smoke.ts` with the real payload shape (id/action/resources)
so the fallback-to-"tool" regression can't silently return.

### I6 — LOW: opencode plugin's tool-name/input map never cleared at session end
The `tools` Map grows for the lifetime of the server process (the background service is
long-lived and hosts many sessions); entries are deleted only on
`session.tool.success|failed`. A tool call that never reaches a terminal event (e.g. the
session dies mid-tool, or an ask is rejected) leaks its entry. Minor, but on a
days-long service it accumulates. Fix: also clear on `session.execution.started`
(fresh turn ⇒ stale ids are dead) or on the execution.succeeded/failed/interrupted
toasts; add a smoke assertion.

### I7 — LOW (design decision, not a bug): PreToolUse fires before the permission decision
Live ordering observed: `PreToolUse` (tool_start) → `permission.asked` → …pending…
→ no PostToolUse while the ask pends. So PaiR's activity feed shows a tool_start for a
command the user may then reject. Options: leave as-is (feed shows intent — arguably
useful), or defer the PreToolUse notify until permission resolves (needs tracking the
pending tool id against the permission's `source.messageID`/`source.id`). Needs a
product call; document whichever way it lands.

## 3. Missing features (implement when unblocked)

- **M1 — omp/opencode channels & badges**: pai-r 0.47.0 has no `omp`/`opencode`
  ai-name; badges default to `gemini`/`codex`. Ask the PaiR maintainer
  (Laurent Chapin, w3dev.fr) to add channels, then flip the `PAIR_AI_NAME` defaults.
- **M2 — two-way observation**: cables/inbox typing into omp/opencode is not wired
  (needs a per-agent mod, as Claude Code has). Out of this repo's control; tracked
  here so it is not forgotten.
- **M3 — Qwen Code**: no lifecycle hook surface; documented as not covered. No action.

## 4. QA manual test plan (needs the PaiR app UI; headless asserts noted)

Setup: PaiR-managed terminal + herdr, bridges installed per README
(`cp omp/… ~/.omp/agent/extensions/`, `cp opencode/… ~/.config/opencode/plugins/pair.ts`),
new omp/opencode session started after install.

1. **Tool stream** — run a session making tool calls; expect tool_start/tool_end
   pairs in the activity feed. Headless assert (used here):
   `for i in $(seq 1 200); do ps -eo pid,ppid,args | grep -E '[p]air notify' >> /tmp/pair-sampler.log; sleep 0.05; done`
2. **Turn lifecycle** — end a turn → `agent_stop`/"omp: idle"; next prompt →
   `agent_start`. Sampler catches `-t agent_stop … -m omp: idle` without `--json`.
3. **Approval** — trigger an approval-requiring tool; expect a permission toast
   labeled with `event.reason` (fallback `event.toolName`). This path is
   live-unobserved so far — priority for QA.
4. **Gates** — (a) spawn omp from inside an omp session (`OMPCODE=1`) → silent;
   (b) outside a PaiR terminal → silent; (c) `PAIR_NOTIFY=0` → silent.
5. **opencode bridge live run** — now live-verified headless (see §1b: tool stream,
   lifecycle, gates, badge, permission branch all PASS via shim + serve-API probes);
   QA remnant is UI-only: confirm the permission toast label in the PaiR app (after
   I5's fix it should read the action + command, not "tool"), and a rejected-ask flow
   (badge returns to working/idle, no stuck tool_start without tool_end — see I7).
   Known fallback unchanged: missed `session.tool.input.started` → `tool_name: "tool"`.
6. **I1 repro** — run swarm-orchestration-service under a PaiR terminal, dispatch
   one envelope, watch the PaiR feed flood with the dispatched agent's tool events
   (bug present) — then re-run after the fix (silent).

## 5. Open question for the pai-r maintainer

Events acked over the socket never appeared in
`~/.pair/by-project/<project-hash>/<terminal-id>` (0 bytes during the whole live
test). Where does the app persist activity — is that file bus-only (sandboxed)?
Asking because it blocks headless verification of what the UI shows.

## 6. Commands used in this verification

```bash
# CLI contract (all five must ack {"ok":true})
pair notify -t agent_start --ai-name gemini -m 'omp: working' --json
pair notify -t agent_stop  --ai-name gemini -m 'omp: idle' --json
pair notify -t permission  --ai-name gemini -m 'omp approval: test' --json
echo '{"hook_event_name":"PreToolUse","tool_name":"bash","tool_input":{"command":"true"},"cwd":"/tmp"}' \
  | pair notify --hook PreToolUse --ai-name gemini --json
echo '{"hook_event_name":"PostToolUse","tool_name":"bash","tool_input":{"command":"true"},"cwd":"/tmp"}' \
  | pair notify --hook PostToolUse --ai-name gemini --json

# herdr pane state (expect agent:"omp", agent_status transitions)
herdr agent list

# shim smoke suite
bun test/smoke.ts
```

## 6b. opencode probes used in §1b (2026-10-27 second session)

```bash
# Black-box isolation: shim `pair` on PATH (logs argv+stdin, exit 0), then drive a
# session. NOTE: --standalone is REQUIRED — plain `opencode run` attaches to the
# background service, whose PATH/env predate the shim, so the shim never sees calls
# (first test attempt failed exactly this way before the flag was added).
env -C <proj> PATH=/tmp/pair-oc/bin:$PATH PAIR_TERMINAL=probe \
  opencode run --standalone "Use the bash tool to run exactly: echo probe. Then stop."
# Expect in the shim log, in order: agent_start → PreToolUse(shell) → PostToolUse → agent_stop.

# Gates: add PAIR_NOTIFY=0 (expect silent); drop PAIR_TERMINAL with `env -u PAIR_TERMINAL`
# (expect silent — beware leaking your own shell's PAIR_TERMINAL through `env`).

# permission.asked probe — headless run AUTO-DECIDES asks (V2 docs), so drive a real
# server over its HTTP API and never reply to the request. Project config must use the
# V2 shape (V1's "permission"/"bash" keys are silently ignored):
#   { "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }] }
env -C <proj> PATH=/tmp/pair-oc/bin:$PATH PAIR_TERMINAL=probe opencode serve --port 4499
#   → prints "server password <PW>"; auth = HTTP Basic, username "opencode".
SID=$(curl -su "opencode:<PW>" -H 'Content-Type: application/json' \
  -d '{"agent":"build","title":"perm-probe"}' http://127.0.0.1:4499/api/session | jq -r .data.id)
curl -su "opencode:<PW>" -H 'Content-Type: application/json' \
  -d '{"text":"Use the bash tool to run exactly: echo perm-probe. Then stop.","agent":"build"}' \
  http://127.0.0.1:4499/api/session/$SID/prompt
# GET /api/event (SSE) then shows the REAL permission.asked payload
# (data.id/sessionID/action/resources/save/source — no data.title, the I5 evidence);
# the shim log shows the fired toast. Kill the serve when done.
```

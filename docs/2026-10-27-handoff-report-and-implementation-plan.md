# PaiR bridges — handoff report & implementation plan (2026-10-27)

**Source doc:** [`docs/2026-10-27-handoff-verification.md`](2026-10-27-handoff-verification.md)
**Code @ commit:** `807482a` (post-`e37e10f`)
**Scope:** `omp/pair-omp-activity.ts` (OMP↔PaiR bridge), `opencode/pair-plugin/plugin.ts`
(opencode↔PaiR bridge), `test/smoke.ts`, `README.md`.

This report (1) summarizes the verification handoff and (2) turns each identified issue
into a **fix / no-fix decision with rationale** and a concrete, file-level implementation
plan. Every claim below was re-checked against the live source and the in-tree herdr
consumer (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`), not just the handoff prose.

---

## 1. Executive summary

The verification handoff proves both bridges work end-to-end: all 5 `pair notify` shapes
ack `{"ok":true}`, tool + lifecycle events fire per call, herdr reports matching pane
state, and every gate (nested-omp, non-PaiR terminal, kill switch) holds. The opencode
plugin — previously the shim-only gap — is now live-verified black-box (shim on PATH +
real `opencode serve` over HTTP).

Seven issues (I1–I7) and three missing features (M1–M3) are logged. After triage against
the actual code:

| # | Sev | Verdict | Lands in |
|---|---|---|---|
| **I1** | HIGH | **Fix — external** (document here, patch swarm-orchestration-service) | `swarm-orchestration-service` (not this repo) |
| **I2** | MED | **Fix — in repo** (subscribe `session_shutdown` + `session_switch`) | `omp/pair-omp-activity.ts` |
| **I3** | LOW | **No fix — drop** (no status field exists; speculative) | — |
| **I4** | LOW | **Fix — docs only** (README probe command; no code) | `README.md` |
| **I5** | MED | **Fix — in repo** (build message from `action`+`resources`) | `opencode/pair-plugin/plugin.ts` |
| **I6** | LOW | **Fix — in repo** (clear `tools` Map each turn) | `opencode/pair-plugin/plugin.ts` |
| **I7** | LOW | **No fix — document decision** (leave as-is; parity with Claude/OMP) | `README.md` |
| **M1–M3** | — | **No action — blocked upstream / out of scope** | — |

**Net:** 4 in-repo code/doc fixes (I2, I5, I6 + smoke/README), 1 external fix to hand off
(I1), 2 deliberate no-fixes with rationale (I3, I7), 1 docs-only guard (I4).

> **Terminology note — "herdr integration":** the herdr↔omp state bridge
> (`herdr-omp-agent-state.ts`) is **herdr-managed**, not owned by this repo, and is **not**
> in scope for edits. This repo's OMP bridge runs *beside* it and only *reads* it as the
> authoritative reference for the undocumented OMP event surface. I2's fix uses that
> surface (`session_shutdown`/`session_switch`), which is verified present at lines 466/384
> of the herdr consumer.

---

## 2. Verification status recap

**Confirmed working (live evidence in the handoff):**

- **CLI contract** — all 5 shapes ack: `-t agent_start|agent_stop|permission`,
  `--hook PreToolUse|PostToolUse`.
- **OMP bridge** — gates active under `PAIR_TERMINAL`; nested-omp suppressed by `OMPCODE=1`;
  tool events fire per call; turn-end `agent_stop`/"omp: idle" observed; herdr parity
  (`agent: omp`, `working`→`idle`→`working`, `state_change_seq` 16→20).
- **opencode bridge** — plugin loads via v2 default-export + `setup(ctx)`; lifecycle,
  PreToolUse name+args id-join, PostToolUse, kill switch, gate, `PAIR_AI_NAME` badge,
  herdr parity (`agent: opencode`, source `herdr:opencode` v13), and real `pair notify`
  delivery all PASS.
- **Smoke suite** — `bun test/smoke.ts` → 5/5 PASS (re-run in the second session).

**Not live-observed (QA remnants):**

- `agent_start` toast at session open (UI-only).
- `tool_approval_requested` → permission toast label in the PaiR app (UI-only; priority).
- Rejected-ask flow: badge returns to idle, no stuck `tool_start` without `tool_end`
  (interacts with I7).

---

## 3. Issue triage — decisions & rationale

### I1 — HIGH · orchestrator host leaks dispatched-agent activity · **FIX (external)**

**Problem.** `swarm-orchestration-service`'s `src/webhook_receiver/acp_host.py` spawns
`opencode acp` with the full parent env. Run manually from a PaiR-managed terminal, every
dispatched ACP session's opencode inherits `PAIR_TERMINAL`, loads the globally-installed
`~/.config/opencode/plugins/pair.ts`, and floods the dev's PaiR feed with the child's tool
events — exactly the case the README's "Gates and knobs" prescribes `PAIR_NOTIFY=0` for.

**Decision: fix, but NOT in this repo.** The leak is in the spawner, not the bridge. The
bridges already honor `PAIR_NOTIFY=0` (verified in smoke: "opencode kill switch" →
never subscribes). The correct fix is at the `spawn_agent_process` seam in
swarm-orchestration-service (protects every run mode, unlike a per-deployment env tweak).

**Rationale for locating it there:** scrubbing at the spawn seam means the guarantee holds
for *all* dispatched children regardless of how the service itself was launched; a
deployment-unit env var only covers one run mode and is easy to forget.

**Handoff spec (for the swarm-orchestration-service repo):**

```python
# src/webhook_receiver/acp_host.py — in spawn_agent_process, when building child env:
child_env = {**os.environ, "PAIR_NOTIFY": "0"}  # dispatched agents must not report to the dev's PaiR feed
# …pass child_env to the opencode acp spawn instead of the bare parent env…
```

Plus a unit test asserting the scrub: spawn under a fake `PAIR_TERMINAL`, capture the
child env, assert `child_env["PAIR_NOTIFY"] == "0"`.

**This-repo action (docs only):** the README "Gates and knobs" bullet already warns about
this. Add a one-line pointer to this report so the recommendation is discoverable, and
keep QA step §4.6 (I1 repro) as the acceptance check. **No bridge code changes.**

---

### I2 — MED · stale "working" badge on omp death/switch mid-turn · **FIX (in repo)**

**Problem.** `omp/pair-omp-activity.ts` subscribes neither `session_shutdown` nor
`session_switch`. If omp is killed or the session switches mid-turn, PaiR never receives
`agent_stop` and the badge sticks on "working".

**Verified.** The herdr consumer proves both events exist on the same `pi.on(...)` surface:
`session_switch` (line 384), `session_shutdown` (line 466). It also reveals a subtlety the
handoff didn't call out: OMP can emit **duplicate/late `agent_end`** while an auto-retry is
already holding the pane, so herdr guards its idle with an `agentActive` flag (lines
443–453). Our bridge has no such guard.

**Decision: fix.** Subscribe `session_shutdown` (the important one — process death) and
`session_switch` (session changed under us), and emit the same `-t agent_stop`/"omp: idle"
call. To avoid spurious/duplicate idles, gate emission on a lightweight `turnActive` flag
mirroring herdr's `agentActive`:

- `agent_start` → `turnActive = true`
- `agent_end` (when not `willContinue`) → emit `agent_stop`, `turnActive = false`
- `session_shutdown` / `session_switch` → **if `turnActive`**, emit `agent_stop` and clear
  the flag; otherwise no-op (already idle → nothing to correct).

**Files:**
- `omp/pair-omp-activity.ts` — add `let turnActive = false;`, set it in the existing
  `agent_start`/`agent_end` handlers, add the two new `pi.on(...)` subscriptions.
- `test/smoke.ts` — extend the OMP scenario: after an `agent_start` (turn active), fire
  `session_shutdown` and assert an extra `agent_stop`; separately fire `session_shutdown`
  while idle and assert **no** new call (idempotence). Repeat for `session_switch`.

**Sketch:**

```ts
let turnActive = false;
const idle = () => pair(["notify", "-t", "agent_stop", "--ai-name", aiName, "-m", "omp: idle"]);

pi.on("agent_start", () => {
  turnActive = true;
  pair(["notify", "-t", "agent_start", "--ai-name", aiName, "-m", "omp: working"]);
});
pi.on("agent_end", (event) => {
  if (props(event).willContinue === true) return;
  turnActive = false;
  idle();
});
// NEW — correct a badge left on "working" when the turn never settles:
pi.on("session_shutdown", () => { if (turnActive) { turnActive = false; idle(); } });
pi.on("session_switch",   () => { if (turnActive) { turnActive = false; idle(); } });
```

---

### I3 — LOW · PostToolUse payload carries no outcome · **NO FIX (drop)**

**Problem (as logged).** `hookJson` sends `tool_input` only; the Claude PostToolUse shape
also allows `tool_response`. The handoff already conditions this: *"Check the actual
`tool_execution_end` payload for a status field first; if absent, drop this."*

**Investigation.** The only in-tree consumer of `tool_execution_end`
(`herdr-omp-agent-state.ts:429`) reads **just** `event?.toolName` and `event?.args` — no
status/error/exitCode/result/output field is referenced anywhere. Retry/error state in that
consumer comes off **`agent_end`** (`assistant.stopReason`, `assistant.errorMessage`), *not*
off the tool event. There is no evidence OMP's `tool_execution_end` carries a per-tool
outcome, and pai-r 0.47.0's classifier ignores `tool_response` regardless.

**Decision: drop, per the handoff's own instruction.** Adding a speculative `tool_response`
field with no source data and no consumer is dead weight. **No code change.**

**Revisit trigger:** if a future OMP build exposes a status on `tool_execution_end` *and*
pai-r grows `tool_response` support, re-open. Until then this is intentionally closed.

---

### I4 — LOW · pai-r version pin is documentation-only · **FIX (docs only)**

**Problem.** Behavior is pinned to pai-r 0.47.0 (all events on `claude:*`, closed
`--ai-name` set, free-form `-t` types). Nothing fails loudly if a pai-r upgrade changes
`notify` flags.

**Decision: fix in docs, not code.** The smoke suite deliberately uses a PATH **shim** and
never invokes the real `pair` (that hermeticity is a feature — it runs anywhere, no app
needed). Adding a live `pair notify` call to `test/smoke.ts` would couple CI to a running
PaiR app and break that. Instead, document a **manual upgrade probe** in the README so an
upgrade is caught deliberately.

**Files:** `README.md` — add an "Upgrade probe (pai-r)" subsection under Test with the exact
command and expected ack:

```bash
# Run after any pai-r upgrade; all five must ack {"ok":true} and exit 0.
pair notify -t agent_start --ai-name gemini -m 'probe' --json
pair notify -t agent_stop  --ai-name gemini -m 'probe' --json
pair notify -t permission  --ai-name gemini -m 'probe' --json
echo '{"hook_event_name":"PreToolUse","tool_name":"bash","tool_input":{"command":"true"},"cwd":"/tmp"}' \
  | pair notify --hook PreToolUse --ai-name gemini --json
echo '{"hook_event_name":"PostToolUse","tool_name":"bash","tool_input":{"command":"true"},"cwd":"/tmp"}' \
  | pair notify --hook PostToolUse --ai-name gemini --json
```

If any shape stops acking, the bridges' mapping (README table) and possibly the `--ai-name`
closed set need updating. **No bridge code changes.**

---

### I5 — MED · opencode permission toast always degrades to "tool" · **FIX (in repo)**

**Problem.** The plugin reads `str(data?.title)` for the permission message
(`plugin.ts:98`). The live v2.1.4 `permission.asked` payload has **no `data.title`** — it
carries `{ id, sessionID, action, resources, save, source }`. So every permission toast
reads the generic fallback `opencode permission: tool`, even when the real event said
`action: "shell"`, `resources: ["echo perm-probe"]` (verified live in the handoff).

**Decision: fix.** Build the message from the fields that actually exist, keeping `title`
as a forward-compat fallback:

1. `title = str(data?.title)` (future-proofing; currently always undefined).
2. `action = str(data?.action)` (e.g. `"shell"`).
3. `resources = Array.isArray(data?.resources) ? data.resources : []`, stringified safely
   (elements may be non-strings) and joined with `", "`, truncated.
4. `label = title ?? (action ? \`${action}${detail ? \`: ${detail}` : ""}\` : "tool")`.
5. Emit `opencode permission: ${label}`.

**Files:**
- `opencode/pair-plugin/plugin.ts` — replace the `permission.asked` block (lines 97–101)
  with the label builder + a small `truncate` helper (cap ≈ 120 chars).
- `test/smoke.ts` — change the `permission.asked` bus fixture (currently
  `{ title: "Run command" }`, line 99) to the **real shape**
  `{ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo perm-probe"] }`,
  and assert the emitted `-m` contains `shell` and `echo perm-probe` (not `tool`). Keep one
  fixture with a `title` to lock the fallback path.

**Sketch:**

```ts
if (event.type === "permission.asked") {
  const title = str(data?.title);                       // forward-compat; absent in v2.1.4
  const action = str(data?.action);                     // e.g. "shell"
  const resources = Array.isArray(data?.resources) ? data.resources : [];
  const detail = resources.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join(", ");
  const label = title ?? (action ? `${action}${detail ? `: ${truncate(detail, 100)}` : ""}` : "tool");
  pair(["notify", "-t", "permission", "--ai-name", aiName, "-m", `opencode permission: ${label}`]);
}
```

---

### I6 — LOW · opencode `tools` Map never cleared at session end · **FIX (in repo)**

**Problem.** The `tools` Map (`plugin.ts:48`) grows for the lifetime of the long-lived
server process; entries are deleted only on `session.tool.success|failed`. A tool call that
never reaches a terminal event (session dies mid-tool, or an ask is rejected) leaks its
entry. Minor, but it accumulates over days.

**Decision: fix.** Clear the Map on `session.execution.started` — a fresh turn means any
surviving ids from the previous turn are dead. This is the cleanest of the options the
handoff lists (clearing on the terminal toasts is redundant with the existing per-id
`delete`), and it directly covers the "rejected ask never fires PostToolUse" leak.

**Files:**
- `opencode/pair-plugin/plugin.ts` — in the lifecycle branch, call `tools.clear()` when
  `event.type === "session.execution.started"` (before/after the `agent_start` notify).
- `test/smoke.ts` — add an assertion: seed a tool via `session.tool.input.started` with no
  terminal event, fire `session.execution.started`, then confirm a subsequent
  `session.tool.success` for the stale id falls back to `tool_name: "tool"` (proving the
  entry was cleared).

**Sketch:**

```ts
const lifecycle = LIFECYCLE[event.type];
if (lifecycle) {
  if (event.type === "session.execution.started") tools.clear(); // fresh turn ⇒ stale ids are dead
  pair(["notify", "-t", lifecycle, "--ai-name", aiName,
    "-m", `opencode: ${lifecycle === "agent_start" ? "working" : "idle"}`]);
  continue;
}
```

---

### I7 — LOW (design decision) · PreToolUse fires before the permission decision · **NO FIX (document)**

**Problem.** Live ordering: `PreToolUse` (tool_start) → `permission.asked` → …pending… → no
PostToolUse while the ask pends. So the feed shows a `tool_start` for a command the user may
then reject (a dangling `tool_start` with no `tool_end`).

**Decision: leave as-is; document the behavior.** Rationale:

- **Upstream parity.** Claude Code's own `PreToolUse` fires *before* the tool runs
  (permission included); OMP fires `tool_execution_start` before approval resolves too.
  Deferring would make the opencode bridge inconsistent with the very semantics PaiR's
  classifier is built around.
- **Intent signal is useful.** Showing "the agent attempted X" even when X is rejected is
  arguably the more informative feed.
- **Cost of the alternative.** Deferring PreToolUse until the ask resolves requires tracking
  the pending tool id against the permission's `source.messageID`/`source.id` in *both*
  bridges — real added state and coupling for a cosmetic ordering preference.

**Files:** `README.md` — add a "Known limitations" bullet: *PreToolUse/tool_start is emitted
when the tool is attempted, before any permission ask resolves; a rejected ask therefore
leaves a tool_start without a matching tool_end. This mirrors Claude Code / OMP semantics.*

**Revisit trigger:** if the PaiR product owner decides a rejected ask must not show a
`tool_start`, implement the deferral (track pending tool id ↔ permission `source.id`). Until
that product call is made, the current behavior stands.

---

### M1–M3 — missing features · **NO ACTION (blocked / out of scope)**

- **M1 — omp/opencode channels & badges.** pai-r 0.47.0 has no `omp`/`opencode` ai-name;
  badges default to `gemini`/`codex`. **Blocked upstream** — needs the PaiR maintainer
  (Laurent Chapin, w3dev.fr) to add channels. Then the only change is flipping the
  `PAIR_AI_NAME` defaults in both bridges (one line each). No action until channels exist.
- **M2 — two-way observation (cables/inbox typing).** Needs a per-agent mod (as Claude Code
  has). **Out of this repo's control.** Tracked so it isn't forgotten.
- **M3 — Qwen Code.** No lifecycle hook surface (extensions only package
  prompts/MCP/commands). **Documented as not covered. No action.**

---

## 4. Implementation plan (sequenced)

Ordered so in-repo changes land first, tests stay green at each step, and the external fix
is handed off with a precise spec.

### Workstream A — opencode plugin (I5, I6) · in repo

1. **I5** — rewrite the `permission.asked` block in `opencode/pair-plugin/plugin.ts` to
   build the label from `action` + `resources` (truncated), keeping the `title` fallback.
   Add a `truncate(s, n)` helper.
2. **I6** — add `tools.clear()` on `session.execution.started` in the lifecycle branch.
3. **Smoke (I5, I6)** — in `test/smoke.ts`: replace the `permission.asked` fixture with the
   real `{ id, sessionID, action, resources }` shape and assert the message carries
   `shell` + the command; keep a `title`-only fixture for the fallback; add the stale-id
   clear assertion for I6.
4. Run `bun test/smoke.ts` → expect ALL PASSED.

### Workstream B — OMP bridge (I2) · in repo

5. **I2** — in `omp/pair-omp-activity.ts`: add `let turnActive = false`, set/clear it in the
   existing `agent_start`/`agent_end` handlers, and subscribe `session_shutdown` +
   `session_switch` to emit `agent_stop` **only when `turnActive`**.
6. **Smoke (I2)** — extend the OMP scenario: `session_shutdown` while active → extra
   `agent_stop`; while idle → no new call (idempotence); same pair for `session_switch`.
   Update the expected call counts in the existing assertions (currently hard-coded to 5).
7. Run `bun test/smoke.ts` → expect ALL PASSED.

### Workstream C — docs (I4, I7, I1 pointer) · in repo

8. **I4** — add the "Upgrade probe (pai-r)" subsection to `README.md` (Test section).
9. **I7** — add the PreToolUse-before-permission bullet to `README.md` "Known limitations".
10. **I1 pointer** — extend the README "Gates and knobs" `PAIR_NOTIFY=0` bullet with a link
    to this report and the swarm-orchestration-service recommendation.

### Workstream D — external handoff (I1) · swarm-orchestration-service

11. File/patch the `spawn_agent_process` seam to set `PAIR_NOTIFY=0` in the child env, plus
    the scrub unit test (spec in §I1 above). Track in that repo, not here.

### Workstream E — resync installed copies

12. After A–C merge, re-copy the changed bridges to their install targets and diff-verify:
    ```bash
    cp opencode/pair-plugin/plugin.ts ~/.config/opencode/plugins/pair.ts
    cp omp/pair-omp-activity.ts        ~/.omp/agent/extensions/pair-omp-activity.ts
    diff opencode/pair-plugin/plugin.ts ~/.config/opencode/plugins/pair.ts   # expect no output
    diff omp/pair-omp-activity.ts        ~/.omp/agent/extensions/pair-omp-activity.ts
    ```
    Restart opencode / start a new omp session so the changes load.

---

## 5. Acceptance criteria

- `bun test/smoke.ts` → **ALL PASSED**, now additionally covering: OMP
  `session_shutdown`/`session_switch` → `agent_stop` (active) and idempotence (idle);
  opencode permission message = `action` + command (not `tool`); opencode `title` fallback;
  opencode stale-id Map clear.
- **I5 (UI, QA §4.5):** permission toast in the PaiR app reads the action + command
  (e.g. `opencode permission: shell: echo perm-probe`), not `... : tool`.
- **I2 (QA):** killing omp / switching session mid-turn returns the badge to idle within one
  notify; no stuck "working".
- **I1 (QA §4.6):** running swarm-orchestration-service under a PaiR terminal and dispatching
  one envelope produces **no** child tool events in the dev's feed (after the external fix).
- **Installed copies** diff-identical to the repo (Workstream E).
- **No regressions** to the 5 previously-passing smoke assertions or the live-verified
  behaviors in §2.

---

## 6. Out-of-scope / deferred (explicit)

- **I3** — dropped (no status field; speculative). Revisit only if OMP + pai-r both grow support.
- **I7** — behavior left as-is by design; deferral is a future product call.
- **M1/M2/M3** — blocked upstream (pai-r channels), out of repo control (per-agent mod), or
  no hook surface (Qwen). No action.
- **`herdr-omp-agent-state.ts`** — herdr-managed; read-only reference for the OMP event
  surface. Not edited by this plan.

---

## 7. Open question for the pai-r maintainer (carry-forward)

Events acked over the socket never appeared in
`~/.pair/by-project/<project-hash>/<terminal-id>` (0 bytes during the whole live test). Where
does the app persist activity — is that file bus-only/sandboxed? This blocks headless
verification of what the UI shows and is unrelated to any fix above; keep it on the
maintainer thread (Laurent Chapin, w3dev.fr).

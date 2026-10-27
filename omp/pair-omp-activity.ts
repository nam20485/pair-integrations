// PaiR activity bridge for OMP.
// Install: copy to ~/.omp/agent/extensions/pair-omp-activity.ts (loads at next session start).
// Gates: PAIR_TERMINAL set (PaiR-managed terminal); OMPCODE unset (a nested omp shares the
//   parent pane — the parent session's extension owns the PaiR identity); PAIR_NOTIFY != 0.
// Badge label: PAIR_AI_NAME in {claude,cursor,codex,gemini,vibe} (default gemini).
// Note: pair notify delivers all events over its `claude:*` channel; --ai-name only sets
// the badge shown in the PaiR app (no omp channel exists yet in pai-r 0.47.0).
//
// The OMP extension API is undocumented (see the herdr-managed
// herdr-omp-agent-state.ts beside this file for the other in-tree consumer); the
// surface used here is only `pi.on(name, handler)` with unknown event payloads.
import { spawn } from "node:child_process";

interface Pi {
  on(name: string, handler: (event: unknown, ctx: unknown) => void): void;
}

const aiName = process.env.PAIR_AI_NAME || "gemini";
const enabled =
  !!process.env.PAIR_TERMINAL &&
  process.env.OMPCODE !== "1" && // nested omp: parent session's extension owns the identity
  process.env.PAIR_NOTIFY !== "0";

// omp event payloads are undocumented — narrow to a string-indexed record.
function props(event: unknown): Record<string, unknown> {
  return event !== null && typeof event === "object" ? (event as Record<string, unknown>) : {};
}

function pair(args: string[], stdin?: string): void {
  const child = spawn("pair", args, stdin ? { stdio: ["pipe", "ignore", "ignore"] } : { stdio: "ignore" });
  child.on("error", () => {});
  if (stdin) child.stdin!.end(stdin);
  child.unref();
}

function hookJson(event: string, toolName: unknown, toolArgs: unknown): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: typeof toolName === "string" ? toolName : "tool",
    tool_input: toolArgs !== null && typeof toolArgs === "object" ? toolArgs : {},
    cwd: process.cwd(),
  });
}

export default function (pi: Pi): void {
  if (!enabled) return;

  pi.on("agent_start", () => {
    pair(["notify", "-t", "agent_start", "--ai-name", aiName, "-m", "omp: working"]);
  });

  pi.on("agent_end", (event) => {
    if (props(event).willContinue === true) return; // continuation already scheduled, not a settle
    pair(["notify", "-t", "agent_stop", "--ai-name", aiName, "-m", "omp: idle"]);
  });

  pi.on("tool_approval_requested", (event) => {
    const e = props(event);
    const label =
      typeof e.reason === "string" ? e.reason : typeof e.toolName === "string" ? e.toolName : "tool";
    pair(["notify", "-t", "permission", "--ai-name", aiName, "-m", `omp approval: ${label}`]);
  });

  pi.on("tool_execution_start", (event) => {
    pair(["notify", "--hook", "PreToolUse", "--ai-name", aiName],
      hookJson("PreToolUse", props(event).toolName, props(event).args));
  });

  pi.on("tool_execution_end", (event) => {
    pair(["notify", "--hook", "PostToolUse", "--ai-name", aiName],
      hookJson("PostToolUse", props(event).toolName, props(event).args));
  });
}

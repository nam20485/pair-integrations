// PaiR activity bridge for opencode (v2 local plugin contract).
// Install: copy to ~/.config/opencode/plugins/pair.ts (global) or <project>/.opencode/plugins/pair.ts
// Active only inside a PaiR-managed terminal (PAIR_TERMINAL set). Kill switch: PAIR_NOTIFY=0.
// Badge label: PAIR_AI_NAME in {claude,cursor,codex,gemini,vibe} (default codex).
// Note: pair notify delivers all events over its `claude:*` channel; --ai-name only sets
// the badge shown in the PaiR app (no opencode channel exists yet in pai-r 0.47.0).
//
// opencode 2.1.4 loads local plugins with a default export and calls setup(ctx); the
// server()/plugin-hook form is not invoked in v2 run modes (probed first-hand — the
// same pattern as the paseo-terminal-activity.js plugin shipping beside this file).
// Bus payloads live in event.data; the tool NAME only arrives on
// session.tool.input.started (data.name + data.id) and the ARGS on session.tool.called
// (data.input + data.id) — joined here by tool-call id.
import { spawn } from "node:child_process";

interface BusEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface SetupCtx {
  event: { subscribe: (options: { signal: AbortSignal }) => AsyncIterable<BusEvent> };
}

// bus event -> `pair notify -t` toast
const LIFECYCLE: Record<string, string> = {
  "session.execution.started": "agent_start",
  "session.execution.succeeded": "agent_stop",
  "session.execution.failed": "agent_stop",
  "session.execution.interrupted": "agent_stop",
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function pair(args: string[], stdin?: string): void {
  const child = spawn("pair", args, stdin ? { stdio: ["pipe", "ignore", "ignore"] } : { stdio: "ignore" });
  child.on("error", () => {});
  if (stdin) child.stdin!.end(stdin);
  child.unref();
}

export default {
  id: "pair.activity",
  setup(ctx: SetupCtx) {
    if (!(process.env.PAIR_TERMINAL && process.env.PAIR_NOTIFY !== "0")) return () => {};
    const aiName = process.env.PAIR_AI_NAME || "codex";
    const controller = new AbortController();
    const tools = new Map<string, { name: string; input?: unknown }>();

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event.data;

        const lifecycle = LIFECYCLE[event.type];
        if (lifecycle) {
          pair(["notify", "-t", lifecycle, "--ai-name", aiName,
            "-m", `opencode: ${lifecycle === "agent_start" ? "working" : "idle"}`]);
          continue;
        }

        if (event.type === "session.tool.input.started") {
          const id = str(data?.id);
          const name = str(data?.name);
          if (id) tools.set(id, { name: name ?? "tool" });
          continue;
        }

        if (event.type === "session.tool.called") {
          const id = str(data?.id);
          const ref = id ? tools.get(id) : undefined;
          const input = data?.input ?? ref?.input;
          if (ref && input !== undefined) ref.input = input;
          pair(["notify", "--hook", "PreToolUse", "--ai-name", aiName],
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: ref?.name ?? "tool",
              tool_input: input ?? {},
              cwd: process.cwd(),
            }));
          continue;
        }

        if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
          const id = str(data?.id);
          const ref = id ? tools.get(id) : undefined;
          if (id) tools.delete(id);
          pair(["notify", "--hook", "PostToolUse", "--ai-name", aiName],
            JSON.stringify({
              hook_event_name: "PostToolUse",
              tool_name: ref?.name ?? "tool",
              tool_input: ref?.input ?? {},
              cwd: process.cwd(),
            }));
          continue;
        }

        if (event.type === "permission.asked") {
          const title = str(data?.title);
          pair(["notify", "-t", "permission", "--ai-name", aiName,
            "-m", `opencode permission: ${title ?? "tool"}`]);
        }
      }
    })().catch(() => {});

    return () => controller.abort();
  },
};

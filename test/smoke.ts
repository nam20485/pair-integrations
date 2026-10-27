// Smoke: drives both bridges against a PATH-shimmed `pair` and asserts the emitted calls.
// Run from the project root:  bun test/smoke.ts
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";

const root = dirname(new URL(import.meta.url).pathname);
const shimLog = resolve(root, "shim-log.jsonl");

type Call = { args: string[]; stdin: string };
type Summary = { hook: string | null; type: string | null; aiName: string | null; payload: Record<string, unknown> | null };

function resetLog(): void {
  rmSync(shimLog, { force: true });
}

// Polls the shim log until `expected` calls have landed (spawns are async) or timeout.
async function readLog(expected: number): Promise<Call[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    await Bun.sleep(100);
    const calls = existsSync(shimLog)
      ? readFileSync(shimLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call)
      : [];
    if (calls.length >= expected || Date.now() > deadline) return calls;
  }
}

function summarize(calls: Call[]): Summary[] {
  return calls.map((c) => {
    const t = c.args.indexOf("-t");
    const a = c.args.indexOf("--ai-name");
    const h = c.args.indexOf("--hook");
    return {
      type: t >= 0 ? c.args[t + 1]! : null,
      aiName: a >= 0 ? c.args[a + 1]! : null,
      hook: h >= 0 ? c.args[h + 1]! : null,
      payload: c.stdin ? (JSON.parse(c.stdin) as Record<string, unknown>) : null,
    };
  });
}
// Fire-and-forget spawns complete in arbitrary order — look calls up, never index them.
const byType = (type: string) => s.find((x) => x.type === type);
const byHook = (hook: string) => s.find((x) => x.hook === hook);

// ---- environment for the ENABLED scenario (modules read env at import) ----
process.env.PAIR_SHIM_LOG = shimLog;
process.env.PAIR_TERMINAL = "pty-smoke";
process.env.PATH = resolve(root, "shim") + ":" + process.env.PATH;
delete process.env.OMPCODE;
delete process.env.PAIR_AI_NAME;
delete process.env.PAIR_NOTIFY;

// Dynamic imports throughout: both bridges read process.env at module evaluation, and each
// scenario needs a fresh evaluation under different env (query strings bust bun's module
// cache) — a static import evaluates once and cannot re-evaluate.
const ompHandlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => void>>();
const pi = {
  on(name: string, handler: (event: unknown, ctx: unknown) => void) {
    const list = ompHandlers.get(name) ?? [];
    list.push(handler);
    ompHandlers.set(name, list);
  },
};
(await import("../omp/pair-omp-activity.ts")).default(pi);
const fireOmp = (name: string, event?: unknown) => ompHandlers.get(name)?.forEach((h) => h(event, {}));

resetLog();
fireOmp("agent_start");
fireOmp("tool_execution_start", { toolName: "bash", args: { command: "ls" } });
fireOmp("tool_approval_requested", { reason: "bash: rm -rf" });
fireOmp("agent_end", { willContinue: true }); // must be ignored
fireOmp("agent_end", {});
fireOmp("tool_execution_end", { toolName: "bash", args: { command: "ls" } });

let s = summarize(await readLog(5));
assert.equal(s.length, 5, `omp: expected 5 calls, got ${s.length}`);
assert.deepEqual(
  [...s.map((x) => x.type).sort()],
  [null, null, "agent_start", "agent_stop", "permission"].sort(),
  "omp: emitted toast set",
);
assert.equal(byType("agent_start")!.aiName, "gemini", "omp: default ai-name");
assert.equal(byHook("PreToolUse")!.payload!.tool_name, "bash", "omp: tool start via hook classifier");
assert.deepEqual(byHook("PreToolUse")!.payload!.tool_input, { command: "ls" });
assert.equal(byHook("PostToolUse")!.payload!.tool_name, "bash", "omp: tool end via hook classifier");
console.log("PASS omp enabled (5 calls: start/Pre/permission/stop/Post)");

// ---- opencode plugin, enabled (v2 setup + event-bus contract) ----
const plugin = (await import("../opencode/pair-plugin/plugin.ts")).default;

type BusEvent = { type: string; data?: Record<string, unknown> };
const bus: BusEvent[] = [
  { type: "session.execution.started" },
  { type: "session.tool.input.started", data: { id: "toolu_1", name: "shell" } },
  { type: "session.tool.called", data: { id: "toolu_1", input: { command: "ls" } } },
  { type: "session.tool.success", data: { id: "toolu_1" } },
  { type: "permission.asked", data: { title: "Run command" } },
  { type: "session.execution.succeeded" },
];
const { promise: busOpen, resolve: closeBus } = Promise.withResolvers<void>();
async function* busStream(): AsyncIterable<BusEvent> {
  for (const event of bus) yield event;
  await busOpen;
}
const opencodeCtx = {
  event: { subscribe: (_options: { signal: AbortSignal }) => busStream() },
};
resetLog();
const cleanup = plugin.setup(opencodeCtx);

s = summarize(await readLog(5));
assert.equal(s.length, 5, `opencode: expected 5 calls, got ${s.length}`);
assert.deepEqual(
  [...s.map((x) => x.type).sort()],
  [null, null, "agent_start", "agent_stop", "permission"].sort(),
  "opencode: emitted toast set",
);
assert.equal(byHook("PreToolUse")!.payload!.tool_name, "shell");
assert.deepEqual(byHook("PreToolUse")!.payload!.tool_input, { command: "ls" });
assert.equal(byHook("PostToolUse")!.payload!.tool_name, "shell");
assert.equal(byType("permission")!.type, "permission", "opencode: permission.asked -> permission");
assert.equal(byType("agent_start")!.aiName, "codex", "opencode: default ai-name");
assert.equal(byType("agent_stop")!.type, "agent_stop", "opencode: execution.succeeded -> agent_stop");
cleanup();
closeBus();
console.log("PASS opencode enabled (5 calls: start/Pre/Post/permission/stop)");

// ---- disabled scenarios: no further `pair` invocations ----
async function assertSilent(label: string, mutate: () => void, act: () => Promise<void>): Promise<void> {
  mutate();
  const before = existsSync(shimLog) ? readFileSync(shimLog, "utf8").split("\n").filter(Boolean).length : 0;
  await act();
  await Bun.sleep(400);
  const after = existsSync(shimLog) ? readFileSync(shimLog, "utf8").split("\n").filter(Boolean).length : before;
  assert.equal(after, before, `${label}: expected no pair calls`);
  console.log(`PASS ${label} (silent)`);
}

// OMP: nested session (OMPCODE=1)
await assertSilent(
  "omp nested (OMPCODE=1)",
  () => {
    process.env.OMPCODE = "1";
  },
  async () => {
    const handlers = new Map<string, Array<(event?: unknown) => void>>();
    const nestedPi = { on: (n: string, h: (event: unknown) => void) => { const l = handlers.get(n) ?? []; l.push(h); handlers.set(n, l); } };
    (await import("../omp/pair-omp-activity.ts?nested")).default(nestedPi);
    handlers.forEach((hs) => hs.forEach((h) => h({ toolName: "bash" })));
  },
);

// OMP: outside PaiR (no PAIR_TERMINAL)
delete process.env.OMPCODE;
delete process.env.PAIR_TERMINAL;
await assertSilent(
  "omp outside PaiR (no PAIR_TERMINAL)",
  () => {},
  async () => {
    const handlers = new Map<string, Array<(event?: unknown) => void>>();
    const barePi = { on: (n: string, h: (event: unknown) => void) => { const l = handlers.get(n) ?? []; l.push(h); handlers.set(n, l); } };
    (await import("../omp/pair-omp-activity.ts?bare")).default(barePi);
    handlers.forEach((hs) => hs.forEach((h) => h({ toolName: "bash" })));
  },
);

// opencode: kill switch
process.env.PAIR_TERMINAL = "pty-smoke";
process.env.PAIR_NOTIFY = "0";
await assertSilent(
  "opencode kill switch (PAIR_NOTIFY=0)",
  () => {},
  async () => {
    const off = (await import("../opencode/pair-plugin/plugin.ts?off")).default;
    let subscribed = false;
    const cleanup = off.setup({ event: { subscribe: () => { subscribed = true; return busStream(); } } });
    cleanup();
    assert.equal(subscribed, false, "opencode kill switch: never subscribes");
  },
);

rmSync(shimLog, { force: true });
console.log("\nALL SMOKES PASSED");

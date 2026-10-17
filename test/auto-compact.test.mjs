import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, decide, resolveConfig, resolveStatusPath } from "../lib/index.js";

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

test("resolveConfig 使用默认值", () => {
  const config = resolveConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.thresholdRatio, 0.45);
  assert.equal(config.idleMs, 180000);
  assert.equal(config.pollMs, 15000);
  assert.equal(config.dryRun, false);
});

test("resolveConfig 接受覆盖并拒绝越界值", () => {
  const config = resolveConfig({ thresholdRatio: 0.6, idleMs: 90000, thresholdRatioBad: 1, pollMs: 0 });
  assert.equal(config.thresholdRatio, 0.6);
  assert.equal(config.idleMs, 90000);
  assert.equal(config.pollMs, 15000); // 0 越界 → 回退
  const clamped = resolveConfig({ thresholdRatio: 4 });
  assert.equal(clamped.thresholdRatio, 0.45);
});

test("resolveConfig 让巡检间隔不超过静默窗口", () => {
  const config = resolveConfig({ idleMs: 10000, pollMs: 15000 });
  assert.equal(config.pollMs, 2500);
  // 巡检本来就比静默窗口细时保持不变。
  assert.equal(resolveConfig({ idleMs: 200000, pollMs: 15000 }).pollMs, 15000);
});

test("resolveStatusPath 支持关闭与自定义路径", () => {
  assert.equal(resolveStatusPath(false), undefined);
  assert.equal(resolveStatusPath("C:/tmp/x.json"), "C:/tmp/x.json");
  assert.ok(resolveStatusPath(true).endsWith("auto-compact.status.json"));
});

test("decide 覆盖所有跳过原因", () => {
  const base = {
    status: "idle",
    now: 10_000_000,
    lastActivityAt: 10_000_000 - 200_000,
    lastAttemptAt: 0,
    totalTokens: 500_000,
    contextWindow: 1_000_000,
    thresholdRatio: 0.45,
    idleMs: 180_000,
    cooldownMs: 300_000,
  };
  assert.deepEqual(decide(base), { compact: true, reason: "idle-above-threshold" });
  assert.equal(decide({ ...base, enabled: false }).reason, "disabled");
  assert.equal(decide({ ...base, busy: true }).reason, "busy");
  assert.equal(decide({ ...base, status: "running" }).reason, "agent-running");
  assert.equal(decide({ ...base, lastActivityAt: 10_000_000 - 1000 }).reason, "recently-active");
  assert.equal(decide({ ...base, lastAttemptAt: 10_000_000 - 1000 }).reason, "cooldown");
  assert.equal(decide({ ...base, contextWindow: undefined }).reason, "unknown-context-window");
  assert.equal(decide({ ...base, totalTokens: undefined }).reason, "no-measurement");
  assert.equal(decide({ ...base, minTokens: 600_000 }).reason, "below-min-tokens");
  assert.equal(decide({ ...base, totalTokens: 400_000 }).reason, "below-threshold");
});

test("decide 在边界上刚好命中阈值", () => {
  const result = decide({
    status: "idle",
    now: 1_000_000,
    lastActivityAt: 1_000_000 - 180_000,
    totalTokens: 450_000,
    contextWindow: 1_000_000,
    thresholdRatio: 0.45,
    idleMs: 180_000,
  });
  assert.equal(result.compact, true);
});

/* ------------------------------------------------------------------ *
 * 集成：用假宿主驱动 apply()
 * ------------------------------------------------------------------ */

const realNow = Date.now;
let clockOffset = 0;

function freezeClock() {
  clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
}
function advance(ms) {
  clockOffset += ms;
}
function restoreClock() {
  Date.now = realNow;
  clockOffset = 0;
}

function createHost({ agents, compaction, meter, projections, onCommand, llm = true } = {}) {
  const listeners = new Map();
  const services = new Map();
  const disposers = [];
  const commands = new Map();
  let tickCallback;
  let tickCount = 0;

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, callback) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(callback);
      listeners.set(event, bucket);
      return () => {};
    },
    emit(event, payload) {
      for (const callback of listeners.get(event) ?? []) callback(payload);
    },
    get(serviceName) {
      return services.get(serviceName);
    },
    setInterval(callback) {
      tickCallback = callback;
      return () => {};
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
    agents: { list: () => agents },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
      async execute(agent, line, attachments, signal) {
        onCommand?.({ agent, line, attachments, signal });
        return { commandId: "cmd-1", result: { kind: "success", text: "compacted 3 items" } };
      },
    },
    tokenMeter: { measure: (session) => meter(session) },
  };

  services.set("tokenMeter", ctx.tokenMeter);
  if (projections !== undefined) services.set("sessionProjections", projections);
  if (compaction !== undefined) services.set("compaction", compaction);
  if (llm !== false) {
    services.set("llm", {
      async resolveModelInfo() {
        return { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 128_000 };
      },
    });
  }

  return {
    ctx,
    commands,
    get tickCount() {
      return tickCount;
    },
    async tick() {
      tickCount += 1;
      await tickCallback();
    },
    async settle() {
      for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    async dispose() {
      for (const disposer of disposers.toReversed()) await disposer();
    },
  };
}

function makeAgent(overrides = {}) {
  const agent = {
    id: "session-1",
    status: "idle",
    session: { id: "session-1" },
    options: { provider: "workbuddy", model: "deepseek-v4.1-flash" },
    ctx: { get: () => undefined },
    ...overrides,
  };
  return agent;
}

test("空闲且超阈值时自动压缩一次", async () => {
  freezeClock();
  const calls = [];
  const compaction = {
    async compactNow(agent, signal) {
      calls.push({ agent, signal });
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12345 };
    },
  };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 500_000 }) });

  apply(host.ctx, { idleMs: 180_000, pollMs: 15000, cooldownMs: 300_000, statusFile: false });
  await host.settle();
  assert.equal(calls.length, 0, "刚启动时不算静默");

  advance(181_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 1, "静默 3 分钟后应压缩");
  await host.dispose();
  restoreClock();
});

test("上下文低于阈值时不压缩", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return { shadowedSeqs: [1], shadowedTokenCount: 1 }; } };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 400_000 }) });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  advance(600_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 0);
  await host.dispose();
  restoreClock();
});

test("agent 正在运行时不介入", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return null; } };
  const agent = makeAgent({ status: "running" });
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 900_000 }) });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  advance(600_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 0);
  await host.dispose();
  restoreClock();
});

test("会话事件会刷新静默计时", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return null; } };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 900_000 }) });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  advance(120_000);
  host.ctx.emit("session/event", agent.session, { type: "user/message" });
  advance(120_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 0, "刚有新事件，不该压缩");

  advance(70_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 1);
  await host.dispose();
  restoreClock();
});

test("冷却期内不重复压缩", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return { shadowedSeqs: [1], shadowedTokenCount: 10 }; } };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 900_000 }) });

  apply(host.ctx, { idleMs: 180_000, cooldownMs: 300_000, statusFile: false });
  advance(200_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 1);

  advance(100_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 1, "冷却期内不再触发");

  advance(300_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 2, "冷却结束后可再次触发");
  await host.dispose();
  restoreClock();
});

test("没有 compaction 服务时退回 /compact 命令", async () => {
  freezeClock();
  const seen = [];
  const agent = makeAgent();
  const host = createHost({
    agents: [agent],
    meter: () => ({ totalTokens: 900_000 }),
    onCommand: ({ line }) => seen.push(line),
  });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  advance(200_000);
  await host.tick();
  await host.settle();
  assert.deepEqual(seen, ["/compact"]);
  await host.dispose();
  restoreClock();
});

test("dryRun 只记录不执行", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return null; } };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const host = createHost({ agents: [agent], compaction, meter: () => ({ totalTokens: 900_000 }) });

  apply(host.ctx, { idleMs: 180_000, dryRun: true, statusFile: false });
  advance(200_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 0);
  await host.dispose();
  restoreClock();
});

test("优先使用上下文投影（与界面同源）", async () => {
  freezeClock();
  const calls = [];
  const compaction = { async compactNow() { calls.push(1); return null; } };
  const agent = makeAgent();
  agent.ctx = { get: (key) => (key === "compaction" ? compaction : undefined) };
  const projections = {
    stateOf: (session, key) =>
      key === "contextPressure"
        ? { contextWindow: 1_000_000, pressureTokens: 460_000, surfaceTokens: 0, sampledSurfaceTokens: 0 }
        : undefined,
  };
  const host = createHost({
    agents: [agent],
    compaction,
    projections,
    meter: () => ({ totalTokens: 1 }),
  });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  advance(200_000);
  await host.tick();
  await host.settle();
  assert.equal(calls.length, 1, "投影显示 46% 时应触发");
  await host.dispose();
  restoreClock();
});

test("写入心跳状态文件", async () => {
  freezeClock();
  const dir = mkdtempSync(join(tmpdir(), "auto-compact-"));
  const statusPath = join(dir, "status.json");
  const agent = makeAgent();
  // 这个宿主故意不提供 llm 服务，验证“拿不到上下文窗口”时如实留空。
  const host = createHost({ agents: [agent], meter: () => ({ totalTokens: 500_000 }), llm: false });

  apply(host.ctx, { idleMs: 180_000, statusFile: statusPath });
  advance(200_000);
  await host.tick();
  await host.settle();

  const payload = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(payload.plugin, "dsh-auto-compact");
  assert.equal(payload.config.thresholdRatio, 0.45);
  assert.equal(payload.agents.length, 1);
  assert.equal(payload.agents[0].totalTokens, 500_000);
  assert.equal(payload.agents[0].contextWindow, undefined, "没有窗口信息时应如实留空");
  assert.equal(payload.agents[0].reason, "unknown-context-window");

  await host.dispose();
  rmSync(dir, { recursive: true, force: true });
  restoreClock();
});

test("/autocompact 命令可查询状态", async () => {
  freezeClock();
  const agent = makeAgent();
  const host = createHost({ agents: [agent], meter: () => ({ totalTokens: 123_456 }) });

  apply(host.ctx, { idleMs: 180_000, statusFile: false });
  await host.settle();
  const definition = host.commands.get("autocompact");
  assert.ok(definition, "命令应已注册");
  const result = await definition.handler({ agent, rawInput: "", signal: new AbortController().signal });
  assert.equal(result.kind, "success");
  assert.match(result.text, /45\.0%/);
  await host.dispose();
  restoreClock();
});

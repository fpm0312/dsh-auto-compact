/**
 * dsh-auto-compact — DeepSeek Harness 宿主插件。
 *
 * 作用：当某个会话的上下文占用超过阈值（默认 30%），并且该会话已经静默
 * 一段时间（默认 3 分钟没有任何新事件）时，自动触发一次历史压缩。
 *
 * 设计要点
 * - 只做“决策”，不重新实现压缩：真正的压缩交给 profile 里已挂载的压缩后端
 *   （\`@deepseek-ai/dsh-compaction-basic\`）。它在每个 agent preset 的隔离作用域里，
 *   宿主平面拿不到 \`ctx.compaction\`，因此这里优先用 \`agent.ctx.get('compaction')\`，
 *   拿不到就退回到执行内置的 \`/compact\` 命令 —— 两条路都是同一条官方压缩链路。
 * - 静默判定基于“事件”：会话日志事件、agent 状态变化、收件箱投递都会刷新
 *   最后活跃时间；压缩自身产生的事件同样会刷新，所以不会连环触发。
 * - 只压缩空闲会话：agent 正在跑（status === 'running'）时绝不介入，
 *   避免和正在进行的回合抢状态。
 * - 全部可观测：心跳状态文件 + 日志 + \`/autocompact\` 命令。
 *
 * 该文件不 import 任何 \`@deepseek-ai/*\` 包，因此以 tgz / 目录形式安装时
 * 不需要解析宿主的 peer 依赖，也不会被宿主版本升级破坏。
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 插件名（诊断与日志用）。 */
export const name = "auto-compact";

/**
 * 需要的宿主服务：都是宿主平面的单例。
 * `timer` 必须声明：`ctx.setInterval` 是 timer 插件混入（mixin）的能力，
 * 没注入时访问会直接抛 "cannot get property \"timer\" without inject"。
 */
export const inject = ["agents", "commands", "tokenMeter", "timer"];

const MINUTE = 60 * 1000;

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  /** 总开关。 */
  enabled: true,
  /** 上下文占用比例阈值（相对模型上下文窗口）。 */
  thresholdRatio: 0.30,
  /** 静默多久算“没动静”。 */
  idleMs: 3 * MINUTE,
  /** 巡检间隔。 */
  pollMs: 15 * 1000,
  /** 两次自动压缩尝试之间的冷却时间。 */
  cooldownMs: 5 * MINUTE,
  /** 低于这个绝对 token 数不压缩（防止小会话被误伤）。 */
  minTokens: 0,
  /** 单次压缩的超时时间。 */
  compactTimeoutMs: 10 * MINUTE,
  /** 心跳状态文件：true / false / 绝对路径。 */
  statusFile: true,
  /** 只观察不动作。 */
  dryRun: false,
  /** 压缩通道：'auto' | 'service' | 'command'。 */
  via: "auto",
  /** 是否输出 info 级日志。 */
  verbose: true,
});

/* ------------------------------------------------------------------ *
 * 配置归一化
 * ------------------------------------------------------------------ */

/** 读取一个数字配置项，越界或非数字时回退默认值。 */
function numberOr(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const candidate = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback;
  if (candidate < min || candidate > max) return fallback;
  return candidate;
}

/** 把外部传入的原始配置整理成一份完整、可信的配置对象。 */
export function resolveConfig(input) {
  const raw = input !== null && typeof input === "object" ? input : {};
  const pick = (key) => (raw[key] === undefined ? DEFAULTS[key] : raw[key]);
  const config = {
    enabled: pick("enabled") !== false,
    thresholdRatio: numberOr(pick("thresholdRatio"), DEFAULTS.thresholdRatio, { min: 0.01, max: 1 }),
    idleMs: numberOr(pick("idleMs"), DEFAULTS.idleMs, { min: 1000 }),
    pollMs: numberOr(pick("pollMs"), DEFAULTS.pollMs, { min: 1000 }),
    cooldownMs: numberOr(pick("cooldownMs"), DEFAULTS.cooldownMs, { min: 0 }),
    minTokens: numberOr(pick("minTokens"), DEFAULTS.minTokens, { min: 0 }),
    compactTimeoutMs: numberOr(pick("compactTimeoutMs"), DEFAULTS.compactTimeoutMs, { min: 1000 }),
    statusFile: pick("statusFile"),
    dryRun: pick("dryRun") === true,
    via: ["auto", "service", "command"].includes(pick("via")) ? pick("via") : DEFAULTS.via,
    verbose: pick("verbose") !== false,
  };
  // 巡检必须比静默窗口更细，否则可能整整多等一个窗口。
  if (config.pollMs > config.idleMs) config.pollMs = Math.max(1000, Math.floor(config.idleMs / 4));
  return config;
}

/** 解析心跳状态文件路径；false 表示关闭。 */
export function resolveStatusPath(value) {
  if (value === false || value === null) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "auto-compact.status.json");
}

/* ------------------------------------------------------------------ *
 * 纯决策：给定快照，判断此刻该不该压缩
 * ------------------------------------------------------------------ */

/**
 * 纯函数决策，方便单测与状态文件解释。
 * @returns {{ compact: boolean, reason: string }}
 */
export function decide(input) {
  const {
    enabled = true,
    status,
    busy = false,
    now = Date.now(),
    lastActivityAt = now,
    lastAttemptAt = 0,
    totalTokens,
    contextWindow,
    ratio,
    thresholdRatio = DEFAULTS.thresholdRatio,
    minTokens = 0,
    idleMs = DEFAULTS.idleMs,
    cooldownMs = DEFAULTS.cooldownMs,
  } = input ?? {};
  if (!enabled) return { compact: false, reason: "disabled" };
  if (busy) return { compact: false, reason: "busy" };
  if (status !== "idle") return { compact: false, reason: "agent-running" };
  const idleFor = now - lastActivityAt;
  if (idleFor < idleMs) return { compact: false, reason: "recently-active" };
  const sinceAttempt = now - lastAttemptAt;
  if (sinceAttempt < cooldownMs) return { compact: false, reason: "cooldown" };
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { compact: false, reason: "unknown-context-window" };
  }
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return { compact: false, reason: "no-measurement" };
  }
  if (totalTokens < minTokens) return { compact: false, reason: "below-min-tokens" };
  const effective = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : totalTokens / contextWindow;
  if (effective < thresholdRatio) return { compact: false, reason: "below-threshold" };
  return { compact: true, reason: "idle-above-threshold" };
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

/**
 * 注册空闲期自动压缩。
 * @param ctx 宿主 Cordis 上下文。
 * @param input 插件配置（profile patch 里的 config）。
 */
export function apply(ctx, input) {
  const config = resolveConfig(input);
  const logger = ctx.logger;
  const statusPath = resolveStatusPath(config.statusFile);

  /** 每个 agent 一份运行时状态；用 WeakMap 避免泄漏。 */
  const states = new WeakMap();
  /** 正在执行的压缩任务，卸载时等待它们收尾。 */
  const active = new Set();
  /** 卸载信号：所有在途压缩都会被取消。 */
  const shutdown = new AbortController();

  let disposed = false;
  let ticking = false;
  let lastTickAt = 0;
  let lastWriteAt = 0;
  let lastWriteError;
  let compactCount = 0;
  let lastCompactAt = 0;

  const info = (message) => {
    if (config.verbose) logger.info("[auto-compact] " + message);
  };
  const warn = (message) => logger.warn("[auto-compact] " + message);

  if (!config.enabled) {
    info("已通过配置关闭");
    return;
  }
  if (!statusPath && config.dryRun) {
    // 仍可运行，只是没有心跳可看。
  }

  /* ---------------- agent 状态 ---------------- */

  function stateFor(agent) {
    // WeakMap 不接受原始值/undefined 作为键；正常路径不会走到这里，但别让巡检崩掉。
    if (agent === null || typeof agent !== "object") {
      return { id: "unknown", lastActivityAt: Date.now(), lastAttemptAt: 0, busy: false, lastAction: "invalid-agent", reason: "invalid-agent" };
    }
    let state = states.get(agent);
    if (state === undefined) {
      const now = Date.now();
      state = {
        id: typeof agent?.id === "string" ? agent.id : "unknown",
        createdAt: now,
        lastActivityAt: now,
        lastAttemptAt: 0,
        busy: false,
        lastAction: "init",
        lastError: undefined,
        totalTokens: undefined,
        contextWindow: undefined,
        ratio: undefined,
        reason: "never-checked",
        checkedAt: 0,
      };
      states.set(agent, state);
    }
    return state;
  }

  function touch(agent) {
    if (agent === undefined || agent === null) return;
    stateFor(agent).lastActivityAt = Date.now();
  }

  /** 从会话反查 agent；同时活着的 agent 很少，直接线性查即可。 */
  function agentForSession(session) {
    let list;
    try {
      list = ctx.agents.list();
    } catch {
      return undefined;
    }
    for (const agent of list) {
      if (agent?.session === session) return agent;
    }
    return undefined;
  }

  /* ---------------- 事件：刷新活跃时间 ---------------- */

  ctx.on("agent/created", ({ agent }) => {
    const state = stateFor(agent);
    state.lastActivityAt = Date.now();
    state.lastAction = "created";
  });

  ctx.on("agent/status", ({ agent }) => touch(agent));
  ctx.on("agent/inbox/inserted", ({ agent }) => touch(agent));

  ctx.on("session/event", (session) => {
    const agent = agentForSession(session);
    if (agent !== undefined) touch(agent);
  });

  ctx.on("agent/disposed", ({ agent }) => {
    states.delete(agent);
  });

  /* ---------------- 测量 ---------------- */

  /** 读取会话上下文占用：优先用 token-meter 的上下文投影（和界面数字同源）。 */
  async function measure(agent) {
    const session = agent?.session;
    let totalTokens;
    let contextWindow;
    let source;

    try {
      const projections = ctx.get("sessionProjections");
      const pressure = projections?.stateOf?.(session, "contextPressure");
      if (pressure !== undefined && pressure !== null) {
        if (Number.isInteger(pressure.contextWindow) && pressure.contextWindow > 0) {
          contextWindow = pressure.contextWindow;
        }
        if (typeof pressure.pressureTokens === "number") {
          const surface = typeof pressure.surfaceTokens === "number" ? pressure.surfaceTokens : 0;
          const sampled = typeof pressure.sampledSurfaceTokens === "number" ? pressure.sampledSurfaceTokens : surface;
          totalTokens = Math.max(0, pressure.pressureTokens + surface - sampled);
          source = "projection";
        }
      }
    } catch (error) {
      // 投影未注册或会话尚未 fold：走下面的兜底。
    }

    if (totalTokens === undefined) {
      try {
        const measurement = ctx.tokenMeter.measure(session);
        if (measurement !== undefined && Number.isFinite(measurement.totalTokens)) {
          totalTokens = measurement.totalTokens;
          source = "meter";
        }
      } catch (error) {
        return { source: "unavailable", error: describe(error) };
      }
    }

    if (contextWindow === undefined) {
      const target = routedTarget(agent);
      const llm = ctx.get("llm");
      if (target !== undefined && llm !== undefined) {
        try {
          const modelInfo = await llm.resolveModelInfo(target.provider, target.model);
          const window = modelInfo?.context?.contextWindow;
          if (Number.isInteger(window) && window > 0) contextWindow = window;
        } catch (error) {
          // 适配器没给上下文容量时只能放弃这一轮。
        }
      }
    }

    const ratio = typeof totalTokens === "number" && typeof contextWindow === "number" && contextWindow > 0
      ? totalTokens / contextWindow
      : undefined;

    return { totalTokens, contextWindow, ratio, source };
  }

  /** 会话最近一次请求路由到的 provider/model。 */
  function routedTarget(agent) {
    try {
      const routed = agent?.session?.requestHeader?.()?.config;
      if (routed !== undefined && routed.provider && routed.model) {
        return { provider: routed.provider, model: routed.model };
      }
    } catch (error) {
      // 没有请求头就退回 agent 选项。
    }
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider === "string" && provider !== "" && typeof model === "string" && model !== "") {
      return { provider, model };
    }
    return undefined;
  }

  /* ---------------- 压缩通道 ---------------- */

  /** 取 agent 作用域里的服务（preset 的隔离服务只有这一条路）。 */
  function agentScopedService(agent, key) {
    try {
      const scoped = agent?.ctx?.get?.(key);
      if (scoped !== undefined && scoped !== null) return scoped;
    } catch (error) {
      // 作用域已销毁或没有该服务。
    }
    return undefined;
  }

  /** 执行一次压缩；返回可写入状态文件的描述。 */
  async function runCompaction(agent, signal) {
    const preferService = config.via !== "command";
    const preferCommand = config.via !== "service";

    if (preferService) {
      const compaction = agentScopedService(agent, "compaction");
      if (compaction !== undefined && typeof compaction.compactNow === "function") {
        const result = await compaction.compactNow(agent, signal);
        if (result === null) return { via: "service", kind: "noop", text: "没有可压缩的历史" };
        const items = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
        const tokens = typeof result.shadowedTokenCount === "number" ? result.shadowedTokenCount : 0;
        return { via: "service", kind: "success", items, tokens, text: "压缩了 " + items + " 条历史（约 " + tokens + " tokens）" };
      }
      if (config.via === "service") {
        return { via: "service", kind: "missing", text: "当前 preset 没有挂载 compaction 服务" };
      }
    }

    if (preferCommand) {
      const execution = await ctx.commands.execute(agent, "/compact", [], signal);
      if (execution === undefined) {
        return { via: "command", kind: "missing", text: "当前会话没有可用的 /compact 命令" };
      }
      const result = execution.result ?? {};
      return { via: "command", kind: result.kind ?? "unknown", text: result.text ?? "", sourceEventSeq: result.sourceEventSeq };
    }

    return { via: "none", kind: "skipped", text: "没有可用的压缩通道" };
  }

  /* ---------------- 单个 agent 的巡检 ---------------- */

  async function consider(agent) {
    const state = stateFor(agent);
    if (state.busy) return;

    const usage = await measure(agent);
    state.totalTokens = usage.totalTokens;
    state.contextWindow = usage.contextWindow;
    state.ratio = usage.ratio;
    state.checkedAt = Date.now();

    const decision = decide({
      enabled: config.enabled,
      status: agent?.status,
      busy: state.busy,
      now: state.checkedAt,
      lastActivityAt: state.lastActivityAt,
      lastAttemptAt: state.lastAttemptAt,
      totalTokens: usage.totalTokens,
      contextWindow: usage.contextWindow,
      ratio: usage.ratio,
      thresholdRatio: config.thresholdRatio,
      minTokens: config.minTokens,
      idleMs: config.idleMs,
      cooldownMs: config.cooldownMs,
    });
    state.reason = decision.reason;
    if (!decision.compact) return;

    if (config.dryRun) {
      state.lastAction = "dry-run";
      state.reason = "dry-run-would-compact";
      state.lastAttemptAt = Date.now();
      info("会话 " + state.id + " 命中阈值（" + percent(usage.ratio) + "），dryRun 下不执行压缩");
      return;
    }

    state.busy = true;
    state.lastAttemptAt = Date.now();
    state.lastAction = "compacting";
    info("会话 " + state.id + " 空闲 " + seconds(Date.now() - state.lastActivityAt) + "s，上下文 " + percent(usage.ratio) + "，开始自动压缩");

    const task = (async () => {
      try {
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(config.compactTimeoutMs)]);
        const outcome = await runCompaction(agent, signal);
        state.lastAction = outcome.kind;
        state.lastResult = outcome.text;
        if (outcome.kind === "success") {
          compactCount += 1;
          lastCompactAt = Date.now();
          info("自动压缩完成（" + outcome.via + "）：" + outcome.text);
        } else if (outcome.kind === "missing" || outcome.kind === "noop") {
          info("自动压缩跳过（" + outcome.via + "）：" + outcome.text);
        } else {
          info("自动压缩返回（" + outcome.via + "）：" + outcome.kind + " " + outcome.text);
        }
      } catch (error) {
        state.lastAction = "error";
        state.lastError = describe(error);
        // 预期内的 busy / cancelled 不算故障。
        if (isExpectedCompactionFailure(error)) {
          info("自动压缩未执行：" + state.lastError);
        } else {
          warn("自动压缩失败：" + state.lastError);
        }
      } finally {
        state.busy = false;
        state.lastAttemptAt = Date.now();
        // 压缩本身会写会话事件，这里再抬一次活跃时间，避免紧接着二次触发。
        state.lastActivityAt = Math.max(state.lastActivityAt, Date.now());
        await writeStatus(true);
      }
    })();
    active.add(task);
    task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    await task;
  }

  /* ---------------- 巡检循环 ---------------- */

  async function tick() {
    if (disposed || ticking) return;
    ticking = true;
    lastTickAt = Date.now();
    try {
      const agents = ctx.agents.list();
      for (const agent of agents) {
        if (disposed) break;
        try {
          await consider(agent);
        } catch (error) {
          warn("巡检 " + describe(error));
        }
      }
    } catch (error) {
      warn("巡检失败：" + describe(error));
    } finally {
      ticking = false;
      await writeStatus(false);
    }
  }

  /* ---------------- 心跳状态文件 ---------------- */

  async function writeStatus(force) {
    if (statusPath === undefined || disposed) return;
    const now = Date.now();
    if (!force && now - lastWriteAt < Math.max(1000, Math.floor(config.pollMs / 2))) return;
    lastWriteAt = now;
    const agents = [];
    let list = [];
    try {
      list = ctx.agents.list();
    } catch {
      list = [];
    }
    for (const agent of list) {
      const state = states.get(agent);
      agents.push({
        id: state?.id ?? agent?.id ?? "unknown",
        status: agent?.status,
        lastActivityAt: state?.lastActivityAt,
        idleMs: state === undefined ? undefined : now - state.lastActivityAt,
        totalTokens: state?.totalTokens,
        contextWindow: state?.contextWindow,
        ratio: state?.ratio,
        thresholdRatio: config.thresholdRatio,
        reason: state?.reason,
        lastAction: state?.lastAction,
        lastError: state?.lastError,
        busy: state?.busy ?? false,
        checkedAt: state?.checkedAt,
      });
    }
    const payload = {
      plugin: "dsh-auto-compact",
      version: 1,
      pid: typeof process.pid === "number" ? process.pid : undefined,
      updatedAt: now,
      lastTickAt,
      config: {
        enabled: config.enabled,
        thresholdRatio: config.thresholdRatio,
        idleMs: config.idleMs,
        pollMs: config.pollMs,
        cooldownMs: config.cooldownMs,
        dryRun: config.dryRun,
        via: config.via,
      },
      stats: { compactCount, lastCompactAt: lastCompactAt === 0 ? undefined : lastCompactAt },
      agents,
      writeError: lastWriteError,
    };
    try {
      mkdirSync(dirname(statusPath), { recursive: true });
      const temp = statusPath + ".tmp";
      writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      renameSync(temp, statusPath);
      lastWriteError = undefined;
    } catch (error) {
      lastWriteError = describe(error);
    }
  }

  /* ---------------- /autocompact 命令 ---------------- */

  try {
    ctx.commands.register({
      name: "autocompact",
      description: "查看空闲自动压缩状态；/autocompact now 立即评估一次",
      handler: async (invocation) => {
        const raw = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
        if (raw === "now" || raw === "run") {
          const agent = invocation.agent;
          const state = stateFor(agent);
          state.lastActivityAt = 0; // 手动执行时跳过静默等待
          state.lastAttemptAt = 0;
          await consider(agent);
          return { kind: "success", text: "已评估：" + (state.lastAction ?? "未知") + (state.lastResult ? " — " + state.lastResult : "") };
        }
        const agent = invocation.agent;
        const state = states.get(agent);
        const usage = await measure(agent);
        const lines = [
          "阈值 " + percent(config.thresholdRatio) + "，静默 " + seconds(config.idleMs) + "s，巡检 " + seconds(config.pollMs) + "s" + (config.dryRun ? "（dryRun）" : ""),
          "当前会话：" + (typeof usage.totalTokens === "number" ? usage.totalTokens : "?") + " / " + (typeof usage.contextWindow === "number" ? usage.contextWindow : "?") + " tokens（" + percent(usage.ratio) + "）",
          "空闲 " + (state === undefined ? "?" : seconds(Date.now() - state.lastActivityAt)) + "s，上次判定：" + (state?.reason ?? "未判定"),
          "累计自动压缩 " + compactCount + " 次",
        ];
        return { kind: "success", text: lines.join("\n") };
      },
    });
  } catch (error) {
    warn("注册 /autocompact 命令失败：" + describe(error));
  }

  /* ---------------- 启动与卸载 ---------------- */

  const stopTimer = ctx.setInterval(() => {
    void tick();
  }, config.pollMs);

  ctx.effect(() => () => {
    disposed = true;
    try {
      stopTimer();
    } catch {
      // 已随作用域销毁。
    }
    shutdown.abort(new Error("auto-compact 插件已卸载"));
    return Promise.allSettled([...active]);
  }, "auto-compact teardown");

  info(
    "已启用：上下文 > " + percent(config.thresholdRatio) +
    " 且静默 ≥ " + seconds(config.idleMs) + "s 时自动压缩" +
    "（巡检 " + seconds(config.pollMs) + "s，冷却 " + seconds(config.cooldownMs) + "s" +
    (config.dryRun ? "，dryRun" : "") + "）" +
    (statusPath === undefined ? "" : "；心跳：" + statusPath),
  );

  // 启动后先来一次巡检，让状态文件立刻有内容。
  void tick();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** busy / cancelled 属于正常竞争，不是故障。 */
function isExpectedCompactionFailure(error) {
  if (error === undefined || error === null) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const text = describe(error);
  return code === "busy" || code === "cancelled" || /already has active work|requires an idle agent|was cancelled/i.test(text);
}

function percent(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "?%";
  return (ratio * 100).toFixed(1) + "%";
}

function seconds(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  return (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1);
}

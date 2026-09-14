<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: LLM 运维一体化插件：模型请求自动多次重试（把 provider 的 normal 策略升级为 maxRetries 20）+ Token 预算跟踪（token_budget_* 工具，合并自 dsh-agent-token-budget）
  inject: 'tools','llm','sessionProjections','sessions'
  tools: llm_retry_status,token_budget_status,token_budget_set,token_budget_reset
  runtime: host-only
  envDeps: 无（纯逻辑 + 标准 Node；telegram 通知复用宿主 telegram_send，缺失则静默跳过）
  boundary: 只改当次事件的 retryPolicy，不发起重试（执行器归官方 @deepseek-ai/dsh-llm-retry）；不回写 provider 注册状态
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / dsh-llm ^0.1.0-rc.6 / dsh-agent ^0.1.0-rc.6
-->
# dsh-agent-llm-retry

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-llm-retry"><img src="https://img.shields.io/badge/version-0.2.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-36%20passed-brightgreen" alt="tests">
</p>

**一句话**：一个「重试策略升级器」加一个「Token 用量记账器」——在官方 agent loop 的 `agent/request-error` waterfall 上把 provider 的 `maxRetries` 抬到 20，并可按周期统计会话 token 消耗。

**为什么值得用**：上游 `dsh-llm` 解析出的默认策略是 `maxRetries = 5`，对「偶发一次限流/超时就会中断整轮」的场景偏小；本插件以 **prepend 姿态**先跑，把策略抬到配置值后**无条件放行**官方执行器——加的是余量，不动执行链路。预算侧则把「这个周期烧了多少 token」变成可查询的数字（`token_budget_status`），而不是靠翻日志估。

## 能力

| 工具 | 用途 |
|------|------|
| `llm_retry_status` | 只读诊断：返回生效配置（`maxRetries`/`initialDelayMs`/`maxDelayMs`/`jitterRatio`）与各 provider 的 `original → upgraded` 策略对照 |
| `token_budget_status` | 预算现状：`spentTokens` / `budgetTokens` / `remainingTokens` / `percentUsed` / 活跃与历史会话分解 / `cycle` 与 `reminded` 档位 |
| `token_budget_set` | 输入本周期预算（`budgetTokens`，必填 >0）并**开新周期**（累计清零、档位重置） |
| `token_budget_reset` | 清理记账：`scope=all`（另开新周期）/ `session`（单会话）/ `stale`（历史会话），预算额保留 |

行为侧（无工具）：`agent/request-error` 上的策略升级器；`agent/status(idle)` 上的预算记账与档位提醒（logger + telegram + 会话插话三通道）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-llm-retry": "link:<工作区>/self-plugins/dsh-agent-llm-retry"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-agent-llm-retry
      name: dsh-agent-llm-retry
      config:
        maxRetries: 20
        budgetEnabled: false    # 预算侧默认关闭，需要时再开
```

**3) 30 秒验证**：调 `llm_retry_status` → 期望 `ok: true`、`config.maxRetries === 20`，且 `providers[].upgraded.maxRetries === 20`。若 `budgetEnabled: true`，工具面应额外出现 `token_budget_status` / `token_budget_set` / `token_budget_reset`。

> 前置条件：官方执行器 `@deepseek-ai/dsh-llm-retry` 必须在生效组合内（由 `@deepseek-ai/dsh-base` bundle 挂载）——它不在时本插件的升级**只是策略对象被改写，不会真的多试**。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `maxRetries` | `20` | 目标重试次数；**只升不降**——provider 原值 ≥ 此值或 `mode: 'always'` 时不动 |
| `initialDelayMs` | `500` | 写入新策略的首次退避 |
| `maxDelayMs` | `10000` | 写入新策略的退避上限 |
| `jitterRatio` | `0.1` | 写入新策略的抖动比例 |
| `budgetEnabled` | `true` | 预算侧总开关；`false` 时 `applyBudget` 不执行、3 个 `token_budget_*` 工具不注册（当前线上配置为 `false`） |
| `budget` | 未设 | 预算子配置透传体（见下表） |

预算子配置（`src/budget.ts` 的 `Config`）：

| 项 | 默认 | 说明 |
|----|------|------|
| `budgetTokens` | `500000000` | 周期预算额度；与 `token_budget_set` 的运行态预算同为 0 时不统计 |
| `remindAtPercent` | `[100]` | 档位百分比数组，每档只触发一次；最高档触发后自动开新周期 |
| `remindCooldownMs` | `3600000` | **当前代码未引用**（档位去重靠 `reminded` 数组），遗留字段 |
| `telegramNotify` | `true` | 档位触发时是否走 `telegram_send`（工具不可用则静默跳过） |
| `stateFile` | 未设 → `${DSH_HOME}/token-budget.json` | 记账状态文件路径 |

## 落盘与自证（出问题时先看这里）

**重试侧无落盘产物**——策略升级路径目前只有 `ctx.logger.info`（宿主 logger 不落盘），所以「某次失败到底有没有被升级」无法事后证明。这是本插件已知的**可维护性缺口**（[`docs/semantic.md`](docs/semantic.md) §10 第 2 条），按生态纪律应补 `<DSH_HOME>/llm-retry-trace.jsonl`（`atMs/provider/code/from→to`）。

**预算侧有唯一持久产物**：`${DSH_HOME}/token-budget.json`（`DSH_HOME` 缺省 `~/.dsh`），它不是阶段轨迹而是**状态快照**：

| 字段 | 含义 |
|------|------|
| `sessions` | `sessionId → 累计贡献`（只记 `usageTotal - baseline` 的增量，幂等） |
| `baseline` | 各会话首次记账时的绝对用量定格 |
| `reminded` | 本周期已触发的档位（去重依据） |
| `budgetTokens` | 运行态预算（`token_budget_set` 写入；与配置项同名不同源） |
| `cycle` / `cycleStartedAt` | 周期序号与起点 |
| `updatedAt` | 最后一次落盘时刻 |

**一条命令尽量答五问**（本插件只答得全 ②④，其余见注）：

```bash
cat "$DSH_HOME/token-budget.json"
# ① 跑的是哪个构建 → 文件里没有 build 字段（缺口）；改用 mtime 对照：stat -c %y lib/index.js
# ② 谁发起 / 记了谁 → sessions 的键即被记账的会话；updatedAt 是最后写入时刻
# ③ 断在哪一段     → 无阶段枚举；updatedAt 长期停滞 + 有会话在跑 ⇒ 记账没发生（budgetEnabled=false 时就是如此）
# ④ 结果质量       → cycle / reminded / sessions 条数是否按预期前进
# ⑤ 耗时与预算     → cycleStartedAt → updatedAt 的跨度 = 本周期已计时长
```

行为级验证（无需落盘）：调 `llm_retry_status` / `token_budget_status`——前者证明配置被读到，后者证明记账状态可读出。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/index.ts` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）；
2. **语义级**（最直接）：现读调用 `llm_retry_status`，`config.maxRetries` 与 `providers[].upgraded` 是否等于组合 `config:` 段里的值；
3. **行为级**：工具面出现 4 个工具；`budgetEnabled: true` 时 `${DSH_HOME}/token-budget.json` 的 `updatedAt` 在会话活动后前进。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」（AGENTS §5.11 §6）。另注意 `npm test` 脚本**不含构建步骤**，改完源码务必先 `npm run build`。
>
> 日志旁证（`ready（策略升级 maxRetries=…）` / `策略升级 maxRetries A→B`）走宿主 logger、**不落盘**，不得作为唯一证据。

**回退**（三档）：
- 源码级：`git revert <commit>`（或 `git checkout <上一提交>`）→ `npm run build` → 预检 → 重启；
- 组合级：profile patch 给该行加 `disabled: true`，或调 `plugin_stop dsh-agent-llm-retry` → 停用后 4 个工具消失、`agent/request-error` 不再被升级（退回上游默认策略）；
- 局部级：只把 `config.maxRetries` 改小即可降幅，无需回滚代码。回退后用同一套判据复验（工具消失 / 升级行不再出现）。

## 测试

```bash
npm run build && npm test     # npm test = node --test "tests/*.test.mjs"
```

**36 例离线测试**，全部 `pass`（`# tests 36 / # pass 36 / # fail 0`），**跑的是构建产物**——`tests/*.test.mjs` 从 `../lib/*.js` 导入，所以改源码后必须先构建（脚本本身不含 `tsc`）。

- `tests/policy.test.mjs` — 策略决策：正常升级、无策略注入兜底、`always`/未知 mode 一律 noop、**不降级**（`>=` 配置值不动）、非数值 `maxRetries`（`'2'`/`null`/`NaN`/`Infinity`）不升级、`maxRetries=0` 也升级、幂等
- `tests/budget.test.mjs` — 记账纯函数：四桶合计、损坏 state（顶层非对象/数组/字段畸形）不崩且逐条报 issue、负增量夹到 0、档位取整边界、已提醒去重、未输入预算不除零、返回值为拷贝（幂等投影）
- `tests/contract.test.mjs` — **静态不变量守卫 + 尸体测试**：① `agent/request-error` 监听器末条语句必须是 `return next()`（把放行塞进 `if` 即被判违规）；② `remindText` 的预算参数不得写 `config.budgetTokens`（必须与判定阈值同源）——两处都配了「修前那一行必须被抓到」的尸体样本；③ 入口契约（导出 `name`/`inject`/`apply`，`inject` 含 `llm`）

无需网络、无需真实外部依赖（telegram 通道在测试中不触发）。**未覆盖**：ctx 级集成（构造假 payload 调监听器断言改写 + `next()` 被调；造假 ctx 跑 `applyBudget` 断言落盘）——见 [`docs/semantic.md`](docs/semantic.md) §10 第 9 条。

## 设计要点

- **Waterfall 铁律**：监听器任何分支都必须 `return next()`。短路 = 官方重试执行器永不运行 = 重试静默消失。这条由静态守卫 + 尸体样本锁住。
- **只升不降 / 不改注册状态**：`maxRetries` 已达或超过配置值不动，`mode: 'always'` 不动；只改**当次事件 payload**，不回写 adapter 注册对象。
- **prepend 姿态**：本插件先于官方执行器跑，因此「升级」必须在同一次 waterfall 调用内完成并放行，不得异步延后。
- **可重试码继承优先**：原策略有非空 `retryableCodes` 就沿用，否则回落内置 `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`。
- **纯逻辑与接线分离**：`src/retry-pure.ts`、`src/budget-pure.ts` 不引 `node:fs`、不收 `ctx`，决策句法可离线单测；`index.ts`/`budget.ts` 只做读 payload → 写 payload → 放行、fs、ctx、`new Date()`。
- **反定位**：不是重试执行器、不是 provider 配置真源、不触发压缩、不是计费器（四桶合计含 cache 桶，是近似读数）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单（14 条）、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `dsh-plugin-development` | 机制自证与可维护性工程、DSH 插件开发方法论 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。

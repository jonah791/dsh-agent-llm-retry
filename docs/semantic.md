# dsh-agent-llm-retry · 语义文档

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-llm-retry（LLM 运维一体化：模型请求重试策略升级 + Token 预算跟踪） |
| 主副本路径 | `self-plugins/dsh-agent-llm-retry/docs/semantic.md`（本文件） |
| 实现落点 | `self-plugins/dsh-agent-llm-retry/src/index.ts`（策略升级器 + `llm_retry_status`）<br>`self-plugins/dsh-agent-llm-retry/src/budget.ts`（Token 预算跟踪 + 3 个 `token_budget_*` 工具）<br>`self-plugins/dsh-agent-llm-retry/package.json`（version / exports / peerDependencies）<br>线上挂载点：`E:\alice\.dsh\profiles\web\cordis.patch.yml`（id `agent-agent-llm-retry`） |
| 版本 | 0.2.0（`package.json` version） |
| 状态 | draft |
| 作者 | 爱丽丝 |
| 日期 | 2026-09-14 |

## 1 · 定位与反定位

**是**：一个「策略升级器」+ 一个「用量记账器」的组合插件。
- 策略升级：在官方 agent loop 的 `agent/request-error` waterfall 上以 **prepend** 姿态注册监听器，把 provider 解析出的 `normal` 重试策略**升级**为配置值（默认 `maxRetries` 20），从而让官方重试执行器按更高次数重试。
- 记账：按会话累计 token 用量（增量模型），达档位阈值时双通道提醒（会话插话 + telegram），并暴露 3 个查询/设定/清理工具。

**不是**（反定位）：
- **不是重试执行器**。指数退避、jitter、durable `llm/retry` 事件、重试调度全部归官方 `@deepseek-ai/dsh-llm-retry`（本仓库 = `deepseek-harness/packages/llm/llm-retry`）；本插件只改策略对象，不发起任何重试。
- **不是 provider 配置来源**。provider 的 `retryPolicy` 归各 provider 在 `cordis.patch.yml` 里写；本插件只做「升级/兜底注入」，不接管配置真源。
- **不是上下文/压缩机制**。预算提醒只讲 token 消耗，不触发压缩、不裁剪上下文。
- **不是计费器**。四桶合计是会话投影的近似读数（含 cache 桶），不是账单口径。

## 2 · 术语表

| 术语 | 含义（源码口径） |
|------|-----------------|
| `agent/request-error` | agent loop 的失败步骤扩展点（waterfall）：payload 含 `turn/step/provider/failure/retryPolicy/signal`，`next()` 返回 `RequestErrorAction` |
| `ResolvedRetryPolicy` | 已解析的 provider 策略：`{mode:'normal', maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}` 或 `{mode:'always', ...}` |
| 策略升级 | 当 `policy.mode === 'normal'` 且 `policy.maxRetries < config.maxRetries` 时，用新建的 `RetryPolicyNormal` 覆盖 `payload.retryPolicy` |
| `DEFAULT_RETRYABLE_CODES` | 本插件内置兜底码表：`['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`（与上游 `dsh-llm` 的 `EMPTY_RESPONSE_CODE`/默认码表同名） |
| 周期（cycle） | 预算记账的时间单位：`token_budget_set` 或 `token_budget_reset scope=all` 开新周期，累计清零 |
| 基线（baseline） | 某会话首次记账时的绝对用量；之后只记 `usageTotal - baseline` 的增量（幂等，不重复累加） |
| 档位（remindAtPercent） | 百分比阈值数组（默认 `[100]`），每个档位只触发一次；最高档触发后自动清零开新周期 |

## 3 · 概念模型

**重试侧（index.ts）** — 三段式，职责严格分离：

```
链路：provider 配置 retryPolicy →（adapter 注册时）dsh-llm resolveRetryPolicy → 冻结的 ResolvedRetryPolicy（上游缺省 maxRetries=5）→（请求失败时）agent loop 发 agent/request-error（payload.retryPolicy / failure.code）
方式：① 本插件监听器（prepend，先跑）：normal 且偏小 → 覆盖为 config 值；无条件 next() 放行 ② 官方 llm-retry 执行器（waterfall 下游）：按 payload.retryPolicy 执行指数退避重试 ③ 仍失败 → agent loop 收口（重试耗尽 / 不可重试码）
```
不变量：
1. **无条件 `next()`**：任何分支都必须放行（Waterfall 铁律），不得短路官方执行器。
2. **只升不降**：`maxRetries` 已达或超过配置值时不改；`mode: 'always'` 不动。
3. **不改 provider 注册状态**：只改当次事件 payload，不回写 adapter。
4. **可重试码优先继承**：原策略有非空 `retryableCodes` 就沿用，否则回落 `DEFAULT_RETRYABLE_CODES`。
**预算侧（budget.ts）** — 记账闭环：

```
agent/status(idle) → sessionProjections.snapshot(agent.session).values.tokenUsage → usageTotalOf（uncachedInput + cacheRead + cacheWrite + output 四桶互斥合计）
→ record(agent.id, usageTotal)：基线定格 → 增量贡献 → 累计 → 逐档位比较 → 触发：logger.info + telegram（telegram_send）+ agent.send(createUserMessage, 'next-turn')
→ 最高档触发完毕 → startNewCycle（累计清零、档位重置、cycle+1）
```
持久化：`DSH_HOME/token-budget.json`（`sessions/baseline/reminded/budgetTokens/cycle/cycleStartedAt/updatedAt`）；未输入预算（`budgetTokens<=0` 且 `config.budgetTokens<=0`）时**不统计**——主人 2026-08-18 定调的周期语义。

## 4 · 契约

### 4.1 工具契约

| 工具 | 入参 | 返回要点 |
|------|------|---------|
| `llm_retry_status` | 无 | `ok` + `config{maxRetries,initialDelayMs,maxDelayMs,jitterRatio}` + `providers[]{provider, original, upgraded}` |
| `token_budget_status` | 无 | `ok/tracking/spentTokens/budgetTokens/remainingTokens/percentUsed/sessionsTracked/activeSpent/staleSpent/cycle/cycleStartedAt/reminded` |
| `token_budget_set` | `budgetTokens`(必填,>0)、`reason` | `ok/budgetTokens/cycle/note`；开新周期（清零 + 档位重置） |
| `token_budget_reset` | `scope`(必填: all/session/stale)、`sessionId`、`reason` | `ok/removed/kept/cycle/note`；预算额保留 |

### 4.2 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|--------|-------------------|------|
| 本插件（策略升级器） | `src/index.ts` → `ctx.on('agent/request-error', …, { prepend: true })` → 回调内 `buildPolicy()` | 每次模型请求失败、官方重试执行器之前（prepend 先跑） |
| 官方重试执行器 `@deepseek-ai/dsh-llm-retry` | `deepseek-harness/packages/llm/llm-retry/src/index.ts` → 监听同一 `agent/request-error` | 本插件放行后（下游），按升级后的 `payload.retryPolicy` 执行退避重试 |
| 本插件（状态工具） | `src/index.ts` → `ctx.tools.register(defineTool({ name: 'llm_retry_status' }))` → `execute()` 读 `ctx.llm.adapters`（Map） | 工具被调用时（只读诊断，读 LlmRuntime 私有字段 `adapters`） |
| 本插件（预算记账 + 投影读取） | `src/budget.ts` → `ctx.on('agent/status', …)`（`status === 'idle'` 分支）→ `ctx.sessionProjections.snapshot(agent.session)` → `usageTotalOf()` | 每个 agent 步骤收尾转 idle 时 |
| 本插件（预算提醒投递 + 会话插话） | `src/budget.ts` → `notifyTelegram()` 内 `ctx.tools.get('telegram_send').execute({text, plain:false})`；`agent.send(createUserMessage({source:{kind:'plugin',plugin:'dsh-agent-token-budget'}}), 'next-turn', true)` | 档位触发时（工具不可用 / send 抛错则静默） |
| 本插件（预算工具） | `src/budget.ts` → `ctx.tools.register` × 3（`token_budget_status` / `token_budget_set` / `token_budget_reset`） | 工具被调用时 |
| 宿主组合 | `.dsh/profiles/web/cordis.patch.yml` → `insert: id agent-agent-llm-retry, name dsh-agent-llm-retry, config{budgetEnabled:false, budget{…}}` | web profile 启动装载时 |

### 4.3 配置契约（`Config`，schemastery）

`maxRetries`(默认 20) / `initialDelayMs`(500) / `maxDelayMs`(10000) / `jitterRatio`(0.1) / `budget`(任意，透传) / `budgetEnabled`(默认 true)。
预算子配置（`budget.ts` 的 `Config`）：`budgetTokens`(500000000) / `remindAtPercent`([100]) / `remindCooldownMs`(3600000，当前代码未使用) / `telegramNotify`(true) / `stateFile`(可选，缺省 `DSH_HOME/token-budget.json`)。

## 5 · 边界与信任

- **信任上游类型**：`agent/request-error` 的 payload 走了同一进程的 typed boundary，监听器内用宽类型接收（`payload: any`）只为绕开注入类型的 `readonly` 约束，不做额外运行时校验（源码注释明示）。
- **信任 provider 策略**：不校验 `retryableCodes` 合法性——上游 `resolveRetryPolicy` 已在注册时 fail-loud 校验（非空、无重复、非负安全整数）。
- **只读诊断读私有字段**：`llm_retry_status` 经 `any` 读 `LlmRuntime.adapters`（Map），失败被 `catch {}` 吞掉并返回空 `providers`——这是可维护性缺口（见 §10）。
- **静默降级点**：telegram 工具不可用 → 静默跳过；`agent.send` 抛错 → 静默跳过；state 读写失败 → `logger.warn`（宿主 logger 不落盘，无侧车轨迹）。
- **预算侧外部写入面**：`DSH_HOME/token-budget.json`（跨会话共享文件，多实例并发写为最后写者胜）；**无凭据**——插件不读不存任何密钥，telegram 通道复用宿主 `telegram_send`。

## 6 · 与既有机制的关系

| 机制 | 关系 |
|------|------|
| `@deepseek-ai/dsh-llm-retry`（官方执行器） | **上下游**：本插件改策略，它执行策略。上游组合默认未挂载它时，本插件的升级对实际重试**无效**（只剩状态可诊断）。 |
| `dsh-llm` 的 `resolveRetryPolicy` | **上游真源**：provider 策略解析与默认值由此决定（上游 `DEFAULT_MAX_RETRIES = 5`，见 `packages/llm/llm/src/retry-policy.ts:14`）。 |
| `dsh-agent-token-budget`（原独立插件） | **已合并**：2026-08-21 并入本插件为 `src/budget.ts`（`apply` 更名 `applyBudget` 防与宿主冲突）；工具名沿用 `token_budget_*`，插话 source 仍写 `plugin: 'dsh-agent-token-budget'`（历史留痕）。 |
| `dsh-agent-context` | **同数据源**：都读 `sessionProjections.snapshot(...).values.tokenUsage`（本插件只读不写投影）。 |
| `dsh-token-meter` / 宿主 logger | 投影类型提供方（`TokenUsageProjection`）；本插件全部可观测性目前只有 `ctx.logger`（不落盘），与 §5.22「机制必须自证」不符，见 §10。 |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名 / 命令 / 日志行 / 落盘产物） | 状态 |
|---|-----------|----------------------------------------|------|
| 1 | 插件在 web profile 装载并注册了 4 个工具 | 本会话工具面存在 `llm_retry_status`（实际调用可见）；组合行 `.dsh/profiles/web/cordis.patch.yml:137-146` | 已验证（工具可调用） |
| 2 | 策略升级后的生效值 = 配置值 20 | `llm_retry_status` 返回 `config.maxRetries === 20`、`providers[].upgraded.maxRetries === 20` | 已验证（工具可调用） |
| 3 | 升级分支真的改写了 payload | 需新增单测：构造 `payload.retryPolicy={mode:'normal',maxRetries:5|2,…}` → 断言监听器返回 `next()` 且 `payload.retryPolicy.maxRetries===20` | 待验收（无单测） |
| 4 | `mode:'always'` 与 `maxRetries>=config` 两个分支不改写、无 `retryPolicy` 时注入兜底 | 需新增单测三条（always / 已达 / undefined → 断言 `DEFAULT_RETRYABLE_CODES` + `maxRetries=20`） | 待验收 |
| 5 | 监听器无条件放行（不短路官方执行器） | 单测断言 `next()` 被调用且返回值被透传 | 待验收 |
| 6 | 预算追踪在当前 web 组合下不运行 | `cordis.patch.yml:140` `budgetEnabled: false`；`.dsh/token-budget.json` `updatedAt = 2026-08-21T04:27:35.657Z`（此后无增长） | 已验证（落盘产物） |
| 7 | `token_budget_set` 后开始记账并开新周期 | 调用 `token_budget_set` → 断言返回 `cycle` 递增、`.dsh/token-budget.json` `cycleStartedAt` 更新 | 待验收 |
| 8 | 达档位时累计清零并开新周期；同快照重复触发不重复累加 | 单测两条：spent ≥ 最高档 → 断言 `reminded` 含该档位、`sessions/baseline` 清空、`cycle+1`；同 `usageTotal` 连续两次 `record` → 累计不变 | 待验收 |
| 9 | 线上跑的构建 ≥ 源码最近一次改动 | `lib/index.js` mtime `2026-08-21 12:29:49` ≥ `src/index.ts` mtime `2026-08-21 12:29:19` | 已验证（文件 mtime） |
| 10 | 官方执行器在 web 生效组合内（= 本插件升级有真实下游消费者） | `deepseek-harness/packages/bundle/base/cordis.patch.yml:84-85`（`- id: llm-retry` / `name: '@deepseek-ai/dsh-llm-retry'`）+ `.dsh/profiles/web/package.json` 的 `dsh` 依赖含 `@deepseek-ai/dsh-base` | 已验证（静态取证 2026-09-14） |

## 8 · 与实现的关系

- **实现是唯一真源，本文档是它的语义描述**；文档与实现漂移时以源码为准并回修本文（§9）。
- 本文全部事实取自：`package.json`（v0.2.0）、`README.md`、`src/index.ts`（194 行）、`src/budget.ts`（324 行），以及只读取证——`.dsh/profiles/web/cordis.patch.yml`、`.dsh/profiles/web/package.json`（`link:E:/alice/self-plugins/dsh-agent-llm-retry`）、`.dsh/token-budget.json`、`lib/*.js` mtime。
- **生效判据**（改了代码后怎么证明真的生效）：① **产物新于源码**——比对 `src/*.ts` 与 `lib/*.js` 的 mtime，`lib` 更旧即「改了没构建」；② **进程在跑新构建**——`lib/index.js` mtime vs **web 进程启动时间**（§5.11 §6：重建 ≠ 生效）；③ **语义生效**——现读调用 `llm_retry_status`，看 `config.maxRetries` 与 `providers[].upgraded` 是否等于 `.dsh/profiles/web/cordis.patch.yml` 里 `config:` 段的配置值；④ **日志旁证**——`ctx.logger('dsh-agent-llm-retry')` 的 `ready（策略升级 maxRetries=…）` 与 `策略升级 maxRetries A→B` 行（宿主 logger 不落盘，不可作唯一证据）；⑤ **持久化旁证（预算侧）**——`.dsh/token-budget.json` 的 `cycle/cycleStartedAt/updatedAt` 是否按预期前进。
- **回退**：① 代码级——`git revert`/`git checkout` 回到上一提交（`00d7cf4` 为本文档前最后提交）后重新 `pnpm run build`，再按哨兵协议重启 web；② 组合级——`plugin_stop dsh-agent-llm-retry` 停用（patch `disabled` 切换 + 预检 + 哨兵重启），停用后本插件的 4 个工具消失、`agent/request-error` 不再被升级（退回上游默认策略）；③ 局部级——改小 `cordis.patch.yml` 里的 `maxRetries` 即可降幅，无需回滚代码。回退后同样用上述**生效判据**复验（工具消失 / 升级行不再出现）。

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-14 本文首版（draft）：10 节结构 + 调用点清单 + 可证伪验收清单；全部事实从源码与只读取证读出，未验证项显式标「待验收」
- 2026-09-14 复核补正（队长验收回写）：§10 第 5 条由「未决」升为**已证事实**——官方 `@deepseek-ai/dsh-llm-retry` 经 `@deepseek-ai/dsh-base` bundle 挂载（`packages/bundle/base/cordis.patch.yml:84-85`），组合真源在 bundle 层而非 profile patch；同步在 §7 增第 10 条验收行。教训：**「patch 里没有」不等于「组合里没有」**——判组合真源要追到 bundle/依赖面。

## 10 · 未决问题

1. **上游默认重试次数与源码注释不符**：`src/index.ts:7` 注释称「provider 未配置 retryPolicy 时解析出默认 `maxRetries=2`」，但上游 `retry-policy.ts:14` 的 `DEFAULT_MAX_RETRIES = 5`（`2` 只出现在测试夹具里）。注释需订正——升级阈值判断（`< config.maxRetries`）不受影响，但「为什么需要升级」的叙事要改。
2. **升级是否真的发生无留痕**：`llm_retry_status` 的 `upgraded` 只是**插件配置的镜像**，不是「本次请求实际用了什么」；升级路径只有 `ctx.logger.info`（不落盘），无法事后证明某次失败被升过级。按 §5.22 应补侧车轨迹（如 `<DSH_HOME>/llm-retry-trace.jsonl`：`atMs/provider/code/from→to`）。
3. **依赖私有字段**：`llm_retry_status` 读 `LlmRuntime.adapters`（private，经 `any`）；上游字段改名即静默退化为空 `providers`（`catch {}` 吞错）——需要一条「读不到要响亮」的判据。
4. **backoff 覆盖语义**：本插件把 `initialDelayMs/maxDelayMs/jitterRatio` 一并写进新策略（不保留 provider 原 `backoff`）；若某 provider 显式配了激进退避，升级会**覆盖**它——有意还是疏漏，未定。
5. ~~官方执行器是否在 web 组合中挂载~~ **已核实为真（2026-09-14 复核）**：官方 `@deepseek-ai/dsh-llm-retry` 由 `@deepseek-ai/dsh-base` bundle 挂载——`deepseek-harness/packages/bundle/base/cordis.patch.yml:84-85`（`- id: llm-retry` / `name: '@deepseek-ai/dsh-llm-retry'`），而 web profile 的依赖面含 `@deepseek-ai/dsh-base`（`.dsh/profiles/web/package.json` 的 `dsh` 字段）。结论：官方执行器在生效组合内，**本插件的策略升级对实际重试有效**（不再只是「状态可查」）。原推断被证伪的原因是取错了真源——bundle 行不在 profile 的 `cordis.patch.yml` 里，故「patch 里 grep 零命中」不构成「未挂载」的证据；组合真源须追到 bundle 层（教训记入 §9）。
6. **预算路径当前为死路径**：web 配置 `budgetEnabled: false`，`applyBudget` 不执行，3 个 `token_budget_*` 工具在线上不可见——保留还是改由开关按需启用，待定。
7. **`remindCooldownMs` 未被使用**：配置存在、代码无引用（档位去重靠 `reminded` 数组，足够）——遗留字段还是待接线，未定。
8. **原 dsh-agent-token-budget 仓库**：合并后是否归档，未处理。

/** dsh-agent-llm-retry · Token 预算记账（纯函数，无 IO、无 ctx、时间由调用方注入）。
 *
 * 原 `budget.ts` 把「状态载入/累计/阈值判定/状态投影」全写在 `applyBudget()` 闭包里（依赖 ctx 与 fs），
 * 无法离线验证。这里只搬**决策与算术**：载入规范化、增量贡献、档位判定、状态投影。
 * 落盘（readFileSync/writeFileSync）、事件监听、工具注册、`new Date()` 全留在接线层 `budget.ts`。
 */
export interface BudgetState {
  /** 周期内累计：sessionId → 该会话自周期起点（或首次出现）以来的增量贡献 */
  sessions: Record<string, number>
  /** 周期基线：sessionId → 该会话首次记账时的绝对用量（周期起点/新会话起点） */
  baseline: Record<string, number>
  /** 触发过的档位（percent），防重复提醒 */
  reminded: number[]
  /** 运行态预算（token_budget_set 动态设定）；0=未设定，回落到 config.budgetTokens */
  budgetTokens: number
  /** 周期序号（清零计数） */
  cycle: number
  /** 本周期开始时间 */
  cycleStartedAt: string
  updatedAt: string
}

export interface TokenUsageLike {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export function emptyBudgetState(): BudgetState {
  return { sessions: {}, baseline: {}, reminded: [], budgetTokens: 0, cycle: 0, cycleStartedAt: '', updatedAt: '' }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const numRecord = (v: unknown): Record<string, number> => {
  if (!isPlainObject(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
    else if (typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) out[k] = Number(val)
  }
  return out
}

const numArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []

const positiveNum = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * 载入规范化：**任何损坏/畸形/部分缺失的 state 文件都不得让插件崩**——坏字段回落默认值，
 * 并把问题逐条报给调用方（`issues` 由接线层写日志，不静默）。
 * 合法 state 的语义与旧实现逐条一致（`?? 默认值`），差异只在「旧实现会带着坏值继续算」的畸形输入上。
 */
export function normalizeState(saved: unknown): { state: BudgetState; issues: string[] } {
  const issues: string[] = []
  const base = emptyBudgetState()
  if (saved === undefined || saved === null) return { state: base, issues }
  if (!isPlainObject(saved)) {
    issues.push(`state 顶层不是对象（${Array.isArray(saved) ? 'array' : typeof saved}）——按空状态处理`)
    return { state: base, issues }
  }
  const rawSessions = saved.sessions
  const rawBaseline = saved.baseline
  if (rawSessions !== undefined && !isPlainObject(rawSessions)) issues.push('sessions 字段畸形——已丢弃')
  if (rawBaseline !== undefined && !isPlainObject(rawBaseline)) issues.push('baseline 字段畸形——已丢弃')
  if (saved.reminded !== undefined && !Array.isArray(saved.reminded)) issues.push('reminded 字段畸形——已丢弃')
  const state: BudgetState = {
    sessions: numRecord(rawSessions),
    baseline: numRecord(rawBaseline),
    reminded: numArray(saved.reminded),
    budgetTokens: positiveNum(saved.budgetTokens, 0),
    cycle: positiveNum(saved.cycle, 0),
    cycleStartedAt: typeof saved.cycleStartedAt === 'string' ? saved.cycleStartedAt : '',
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : '',
  }
  return { state, issues }
}

/**
 * 旧格式（2026-08-18 之前的全量绝对量统计）判定：有 sessions 但**没有 baseline**——
 * 无法还原基线（含死会话虚高），按「未输入预算」处理：清零并开新周期。
 */
export function isLegacyState(state: BudgetState): boolean {
  return Object.keys(state.sessions).length > 0 && Object.keys(state.baseline).length === 0
}

/**
 * 投影快照 → 四桶互斥合计（uncachedInput + cacheRead + cacheWrite + output）。
 * 入参取 `unknown`：坏快照（缺 values / 缺 tokenUsage / 字段非数值）一律按 0 计，**不得抛**也不得产出 NaN。
 */
export function usageTotalOf(snapshot: unknown): number {
  const usage = (snapshot as { values?: { tokenUsage?: TokenUsageLike } } | undefined | null)?.values?.tokenUsage ?? {}
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return n(usage.uncachedInputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens) + n(usage.outputTokens)
}

/** 有效预算：运行态设定优先，否则回落配置；<=0 = 未输入预算（不统计）。 */
export function effectiveBudget(stateBudget: number, configBudget: number): number {
  if (stateBudget > 0) return stateBudget
  return configBudget > 0 ? configBudget : 0
}

/** 周期累计总额（各会话增量贡献之和；坏值按 0 计，不产生 NaN）。 */
export function totalSpent(sessions: Record<string, number>): number {
  let sum = 0
  for (const v of Object.values(sessions)) sum += Number.isFinite(v) ? v : 0
  return sum
}

/** 单会话增量贡献：`max(0, 当前绝对用量 - 基线)`（时钟/重置导致的负增量夹到 0）。 */
export function contributionOf(usageTotal: number, baseline: number): number {
  return Math.max(0, usageTotal - baseline)
}

/** 配置里的最高有效档位（<=0 的档位被忽略；全非法则 0 = 无档位）。 */
export function maxRemindPercent(remindAtPercent: readonly number[]): number {
  return Math.max(...remindAtPercent.filter((p) => p > 0), 0)
}

/**
 * 本次记账应触发的档位（保持配置顺序；已触发过的跳过；阈值为 `round(budget*percent/100)`）。
 * 返回数组（可能是空 = 未触发）——调用方据此决定是否插话/推送，**不再用布尔**（要用来播报具体档位）。
 */
export function dueReminders(args: {
  spent: number
  budget: number
  remindAtPercent: readonly number[]
  reminded: readonly number[]
}): number[] {
  const { spent, budget, remindAtPercent, reminded } = args
  const fired: number[] = []
  for (const percent of remindAtPercent) {
    if (!(percent > 0)) continue
    if (reminded.includes(percent)) continue
    if (spent >= Math.round(budget * percent / 100)) fired.push(percent)
  }
  return fired
}

/** 提醒文案（阈值判定与实际预算必须**同源**：文案里的预算必须是在生效的那个）。 */
export function remindText(percent: number, spent: number, budget: number): string {
  return '【Token 预算提醒】已用 ' + (spent / 1e6).toFixed(1) + 'M / ' + (budget / 1e6).toFixed(0) + 'M'
    + '（' + percent + '%）——主人批的预算快用完啦，注意规划接下来的动作 (´▽｀)'
}

/** 最高档是否已触发 → 累计清零开新周期（主人 2026-08-18 定调「提醒完毕之后累计清零」）。 */
export function cycleResetDue(spent: number, budget: number, maxPercent: number): boolean {
  if (!(maxPercent > 0)) return false
  return spent >= Math.round(budget * maxPercent / 100)
}

/** 用量分解：活跃 vs 历史（活跃 = 当前 sessions store 已加载的会话）。 */
export function splitSpentByActive(sessions: Record<string, number>, activeIds: ReadonlySet<string>): {
  active: number; stale: number; activeCount: number; staleCount: number
} {
  let active = 0, stale = 0, activeCount = 0, staleCount = 0
  for (const [sid, v] of Object.entries(sessions)) {
    const amount = Number.isFinite(v) ? v : 0
    if (activeIds.has(sid)) { active += amount; activeCount += 1 } else { stale += amount; staleCount += 1 }
  }
  return { active, stale, activeCount, staleCount }
}

export interface BudgetStatus {
  ok: boolean
  tracking: boolean
  spentTokens: number
  budgetTokens: number
  remainingTokens: number
  percentUsed: number
  sessionsTracked: number
  activeSpent: number
  staleSpent: number
  cycle: number
  cycleStartedAt: string
  reminded: number[]
}

/** `token_budget_status` 的返回值（纯投影：同一 state + 活跃集 → 同一结果）。 */
export function budgetStatus(args: {
  state: BudgetState
  configBudget: number
  activeIds: ReadonlySet<string>
}): BudgetStatus {
  const budget = effectiveBudget(args.state.budgetTokens, args.configBudget)
  const spent = totalSpent(args.state.sessions)
  const split = splitSpentByActive(args.state.sessions, args.activeIds)
  return {
    ok: true,
    tracking: budget > 0,
    spentTokens: spent,
    budgetTokens: budget,
    remainingTokens: Math.max(0, budget - spent),
    percentUsed: budget > 0 ? Math.round(spent / budget * 10000) / 100 : 0,
    sessionsTracked: Object.keys(args.state.sessions).length,
    activeSpent: split.active,
    staleSpent: split.stale,
    cycle: args.state.cycle,
    cycleStartedAt: args.state.cycleStartedAt,
    reminded: [...args.state.reminded],
  }
}

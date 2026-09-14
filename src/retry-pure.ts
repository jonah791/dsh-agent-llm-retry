/** dsh-agent-llm-retry · 重试策略决策（纯函数，无 IO、无 ctx）。
 *
 * 本插件的**唯一职责**是「把重试策略升级」：官方 dsh-llm-retry 是执行器，
 * 本插件在 `agent/request-error` 扩展点上把 normal 策略的 maxRetries 抬到配置值。
 * 这段决策原来写在 `apply()` 的监听器里（依赖 payload/ctx，无法离线验证）——
 * 抽到这里后，`index.ts` 只负责读 payload、写 payload、`next()` 放行。
 */
export const DEFAULT_RETRYABLE_CODES: readonly string[] = [
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
]

export interface RetryPolicyNormal {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export interface RetryPolicyAlways {
  mode: 'always'
}

export type RetryPolicy = RetryPolicyNormal | RetryPolicyAlways

/** 升级参数（Config 的子集，纯函数只依赖这些）。 */
export interface UpgradeConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

/** 决策结果：`action` 是唯一判据，`policy` 是应写回 payload 的值（仅 inject/upgrade 有）。 */
export interface UpgradeDecision {
  action: 'inject' | 'upgrade' | 'noop'
  policy?: RetryPolicyNormal
  /** upgrade 时的原 maxRetries（供日志与诊断：「2→20」） */
  fromMaxRetries?: number
  reason: string
}

/** 按配置构造 normal 策略（保底放行码 = 官方默认）。 */
export function buildPolicy(config: UpgradeConfig, retryableCodes: readonly string[]): RetryPolicyNormal {
  return {
    mode: 'normal',
    maxRetries: config.maxRetries,
    retryableCodes: [...retryableCodes],
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    jitterRatio: config.jitterRatio,
  }
}

/**
 * 策略升级判定（本插件的核心决策）：
 * - 无策略（`undefined`）→ **注入**默认策略（防御分支：llm 正常总会给默认策略）
 * - normal 且 `maxRetries < config.maxRetries` → **升级**（保留原可重试码；缺失/空/非数组 → 用官方默认码）
 * - `always` 模式 / 已 ≥ config 的策略 / 其它畸形值 → **不动**（noop）
 *
 * 不变量：本函数绝不返回「降级」——配置比 provider 小的时候保持 provider 原样，
 * 因为「官方策略更宽松」时把重试次数改小是危险的（会减少容错）。
 */
export function decidePolicyUpgrade(policy: RetryPolicy | undefined | null, config: UpgradeConfig): UpgradeDecision {
  if (policy === undefined || policy === null) {
    return {
      action: 'inject',
      policy: buildPolicy(config, DEFAULT_RETRYABLE_CODES),
      reason: `无策略（防御性注入）→ maxRetries=${config.maxRetries}`,
    }
  }
  const mode = (policy as { mode?: unknown }).mode
  const maxRetries = (policy as { maxRetries?: unknown }).maxRetries
  if (mode !== 'normal') {
    return { action: 'noop', reason: `mode=${String(mode)} 不升级（always/未知模式保持原样）` }
  }
  if (typeof maxRetries !== 'number' || !Number.isFinite(maxRetries)) {
    return { action: 'noop', reason: `maxRetries 非数值（${String(maxRetries)}）不升级` }
  }
  if (maxRetries >= config.maxRetries) {
    return { action: 'noop', reason: `maxRetries=${maxRetries} ≥ 配置 ${config.maxRetries}，无需升级` }
  }
  const raw = (policy as { retryableCodes?: unknown }).retryableCodes
  const codes = Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : DEFAULT_RETRYABLE_CODES
  return {
    action: 'upgrade',
    policy: buildPolicy(config, codes),
    fromMaxRetries: maxRetries,
    reason: `策略升级 maxRetries ${maxRetries}→${config.maxRetries}`,
  }
}

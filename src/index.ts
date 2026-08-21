/**
 * dsh-agent-llm-retry：模型请求自动多次重试（策略升级器 + 状态工具）
 *
 * 背景（2026-08-19 主人需求）：
 * - 官方 @deepseek-ai/dsh-llm-retry 是重试执行器（指数退避 + jitter + durable llm/retry 事件），
 *   但官方组合从未挂载它——模型请求失败没有任何自动重试
 * - provider 未配置 retryPolicy 时，dsh-llm 解析出默认 maxRetries=2（太少，一次失败就接近放弃）
 * - 本插件在 agent/request-error 扩展点 **prepend** 注册：把 normal 策略升级为 maxRetries=20（默认），
 *   官方执行器（patch 挂载）随后用升级后的策略执行重试
 *
 * 2026-08-21 合并 dsh-agent-token-budget：Token 预算跟踪并入本插件（src/budget.ts）。
 *
 * 职责单一：策略升级 + 状态可诊断；重试执行归官方 llm-retry。
 * 铁律：Waterfall 监听器必须 next() 放行；不吞错误、不打断官方执行链。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyBudget, Config as BudgetConfigSchema } from './budget.ts'

export const name = 'agent-llm-retry'
export const inject = ['tools', 'llm', 'sessionProjections', 'sessions'] as const

export interface Config {
  /** 默认最大重试次数（主人 2026-08-19 定调：20） */
  maxRetries: number
  /** 首次退避延迟（ms） */
  initialDelayMs: number
  /** 退避上限（ms） */
  maxDelayMs: number
  /** 抖动比例（0-1，防惊群） */
  jitterRatio: number
  /** 2026-08-21 合并：token 预算配置（透传给 applyBudget，缺省用其默认值） */
  budget?: Record<string, unknown>
  /** 2026-08-21 主人：平时不启用预算插件——false 时不挂载 token 预算跟踪/提醒/工具 */
  budgetEnabled?: boolean
}
export const Config = z.object({
  maxRetries: z.number().default(20),
  initialDelayMs: z.number().default(500),
  maxDelayMs: z.number().default(10000),
  jitterRatio: z.number().default(0.1),
  budget: z.any().required(false),
  budgetEnabled: z.boolean().default(true),
})

/** 官方默认可重试错误码（与 dsh-llm 一致） */
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

interface RetryPolicyNormal {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

function buildPolicy(config: Config, retryableCodes: readonly string[]): RetryPolicyNormal {
  return {
    mode: 'normal',
    maxRetries: config.maxRetries,
    retryableCodes,
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    jitterRatio: config.jitterRatio,
  }
}

interface RequestErrorPayload {
  turn?: number
  step?: number
  provider?: string
  failure?: { code?: string; message?: string }
  retryPolicy?: RetryPolicyNormal | { mode: 'always' } | undefined
  signal?: AbortSignal
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-llm-retry')

  // ---------- ① 策略升级器（prepend：先于官方 llm-retry 执行器运行） ----------
  // payload 用宽松类型：agent/request-error 的注入类型带 readonly 约束，运行时防御已足够
  ctx.on('agent/request-error', async (payload: any, next) => {
    const policy = payload?.retryPolicy as RetryPolicyNormal | { mode: 'always' } | undefined
    const provider = payload?.provider ?? '?'
    const code = payload?.failure?.code ?? '?'
    if (policy === undefined) {
      // 防御性注入（llm 正常总会给默认策略，此分支理论不触发）
      payload.retryPolicy = buildPolicy(config, [...DEFAULT_RETRYABLE_CODES])
      logger.info('注入默认 retryPolicy maxRetries=' + config.maxRetries + ' provider=' + provider + ' code=' + code)
    } else if (policy.mode === 'normal' && policy.maxRetries < config.maxRetries) {
      // 默认 2 次或显式较小值 → 升级到 maxRetries（保留原可重试码；无则用官方默认）
      const codes = Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0 ? policy.retryableCodes : DEFAULT_RETRYABLE_CODES
      payload.retryPolicy = buildPolicy(config, [...codes])
      logger.info('策略升级 maxRetries ' + String(policy.maxRetries) + '→' + config.maxRetries + ' provider=' + provider + ' code=' + code)
    }
    // always 模式 / 已 ≥ maxRetries 的策略：不动；无条件放行官方执行器
    return next()
  }, { prepend: true })

  // ---------- ② 状态工具：查看各 provider 的 retryPolicy 解析结果 ----------
  ctx.tools.register(defineTool({
    name: 'llm_retry_status',
    description: '查看模型请求重试策略状态：各 provider 的 retryPolicy 解析结果（maxRetries/可重试错误码/退避参数）——诊断自动重试是否按预期生效',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              maxRetries: { type: 'number', required: true },
              initialDelayMs: { type: 'number', required: true },
              maxDelayMs: { type: 'number', required: true },
              jitterRatio: { type: 'number', required: true },
            },
          },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                original: { type: 'json' },
                upgraded: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    maxRetries: { type: 'number', required: true },
                    initialDelayMs: { type: 'number', required: true },
                    maxDelayMs: { type: 'number', required: true },
                    jitterRatio: { type: 'number', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_a: unknown, v: any) => [
        {
          type: 'text',
          text: '重试策略（升级后 maxRetries=' + String(v.config?.maxRetries ?? '?') + '）：' + (v.providers ?? []).map((p: any) => {
            const orig = p.original?.maxRetries != null ? String(p.original.maxRetries) : (p.original?.mode === 'always' ? '∞' : '?')
            return p.provider + ' ' + orig + '→' + String(p.upgraded?.maxRetries ?? '?')
          }).join(' · ') || '（无 provider）',
        },
      ],
    },
    async execute() {
      const providers: { provider: string; original: unknown; upgraded: unknown }[] = []
      try {
        // adapters 是 LlmRuntime 的 private 字段：经 any 读取（只读诊断，不写）
        const llm = (ctx as unknown as { llm?: { adapters?: unknown } }).llm
        const adapters = llm?.adapters as Map<string, { retryPolicy?: unknown }> | undefined
        if (adapters instanceof Map) {
          for (const [provider, registration] of adapters) {
            providers.push({
              provider,
              original: registration?.retryPolicy !== undefined
                ? JSON.parse(JSON.stringify(registration.retryPolicy)) as unknown
                : null,
              upgraded: { maxRetries: config.maxRetries, initialDelayMs: config.initialDelayMs, maxDelayMs: config.maxDelayMs, jitterRatio: config.jitterRatio },
            })
          }
        }
      } catch { /* 注册表不可读（防御） */ }
      return {
        ok: true,
        config: { maxRetries: config.maxRetries, initialDelayMs: config.initialDelayMs, maxDelayMs: config.maxDelayMs, jitterRatio: config.jitterRatio },
        providers: providers as never,
      }
    },
  }))

  // 2026-08-21 合并：Token 预算跟踪（原 dsh-agent-token-budget）——用 zod schema 补默认值
  if (config.budgetEnabled !== false) {
    const budgetRaw = (config as { budget?: Record<string, unknown> }).budget
    const budgetConfig = BudgetConfigSchema(budgetRaw ?? {})
    applyBudget(ctx as never, budgetConfig as never)
  }

  ctx.effect(() => {
    logger.info('ready（策略升级 maxRetries=' + config.maxRetries + '；重试执行由官方 llm-retry 承担，需 patch 挂载）')
    return () => { /* 清理 */ }
  })
}

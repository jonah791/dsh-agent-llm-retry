/**
 * dsh-agent-token-budget → 并入 dsh-agent-llm-retry（2026-08-21 合并）。
 * 本文件为原 dsh-agent-token-budget 源码副本，apply 更名 applyBudget 以免与宿主冲突。
 * Token 预算跟踪（爱丽丝 → 主人 5 亿 token 授权落地）
 *
 * 需求（2026-08-17 主人电报）：「给你批 5 个亿 token 的预算，随便你干什么事情都行」
 * +「先开发一个预算插件，到 5 个亿 token 自动提醒」。
 *
 * 设计（爱丽丝自主设计）：
 * - 数据源：ctx.sessionProjections.snapshot(session).values.tokenUsage（与 dsh-agent-context 同源）
 *   —— uncachedInput + cacheRead + cacheWrite + output 四桶互斥合计
 * - 跨会话累计：每个 session 独立记账（sessionId → usageTotal），持久化 DSH_HOME/token-budget.json，
 *   重启/HMR 不丢；同 session 只记最新快照（幂等，不重复累加）
 * - 阈值提醒：监听 agent/status idle，累计 ≥ budgetTokens 时触发
 * - 双通道提醒：① agent.send 会话插话（主人 GUI 可见）② telegram_send 主动推（若 outbound 工具可用）
 * - 工具：token_budget_status（查询累计/剩余/已用会话数）
 * - 配置：budgetTokens 默认 500000000（5 亿）；remindAtPercent 默认 [100]（可配多档）；
 *   telegramNotify 开关默认开（注入 outbound 工具失败则静默跳过）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session'
import {
  budgetStatus, contributionOf, cycleResetDue, dueReminders, effectiveBudget, emptyBudgetState,
  isLegacyState, maxRemindPercent, normalizeState, remindText, totalSpent, usageTotalOf,
  type BudgetState,
} from './budget-pure.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-token-budget': { kind: 'dsh-agent-token-budget' }
  }
}

export const budgetName = 'agent-token-budget'
export const budgetInject = ['sessionProjections', 'tools', 'sessions'] as const

export interface Config {
  budgetTokens: number
  remindAtPercent: number[]
  remindCooldownMs: number
  telegramNotify: boolean
  stateFile?: string
}
export const Config = z.object({
  budgetTokens: z.number().default(500000000),
  remindAtPercent: z.array(z.number()).default([100]),
  remindCooldownMs: z.number().default(3600000),
  telegramNotify: z.boolean().default(true),
  stateFile: z.string().required(false),
})

// ---------- 持久化 ----------
const defaultStateFile = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'token-budget.json')

export function applyBudget(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-token-budget')
  const path = config.stateFile ?? defaultStateFile()

  let state: BudgetState = emptyBudgetState()
  try {
    if (existsSync(path)) {
      const loaded = normalizeState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      state = loaded.state
      for (const issue of loaded.issues) logger.warn('state 载入告警: ' + issue)
    }
  } catch (e) { logger.warn('state 载入失败: ' + String(e)) }
  // 旧格式迁移（2026-08-18 周期模型）：旧数据是全量绝对量（含死会话 5.6 亿虚高），
  // 无法还原基线——按「未输入预算」处理：清零统计，等待主人 token_budget_set 输入预算开新周期
  if (isLegacyState(state)) {
    state.sessions = {}
    state.baseline = {}
    state.reminded = []
    state.cycle = 1
    state.cycleStartedAt = new Date().toISOString()
    logger.warn('旧格式统计已清零（周期模型迁移）：请输入预算后重新统计')
  }

  const persist = (): void => {
    try {
      writeFileSync(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch (e) { logger.warn('state 持久化失败: ' + String(e)) }
  }

  // 有效预算：运行态设定优先，否则回落配置；<=0 = 未输入预算（不统计）
  const effective = (): number => effectiveBudget(state.budgetTokens, config.budgetTokens)

  // 开启新周期：累计清零 + 档位重置 + 基线清空（后续记账从新起点增量）
  const startNewCycle = (note: string): void => {
    state.sessions = {}
    state.baseline = {}
    state.reminded = []
    state.cycle += 1
    state.cycleStartedAt = new Date().toISOString()
    persist()
    logger.info('周期 ' + state.cycle + ' 开始（累计已清零）: ' + note)
  }

  // 活跃会话判定：当前 sessions store 已加载的会话 = 活跃（其余为历史/失效）
  const activeSessionIds = (): Set<string> => new Set((ctx as Context & { sessions?: { list(): { id: string }[] } }).sessions?.list().map((s) => s.id) ?? [])

  // 更新某会话记账并检查阈值；返回**本次触发的档位**（空数组 = 未触发）。
  // 周期语义（主人 2026-08-18 定调）：只有输入预算后才统计；提醒完毕（最高档触发）后累计清零
  const record = (sessionId: string, usageTotal: number): number[] => {
    const budget = effective()
    if (budget <= 0) return [] // 未输入预算：不统计
    // 基线：新会话首次记账时定格绝对用量，之后只记增量（周期起点后的新消耗）
    if (!(sessionId in state.baseline)) {
      state.baseline[sessionId] = usageTotal
      state.sessions[sessionId] = 0
    }
    const contribution = contributionOf(usageTotal, state.baseline[sessionId] ?? usageTotal)
    if (contribution !== state.sessions[sessionId]) {
      state.sessions[sessionId] = contribution
      persist()
    }
    const spent = totalSpent(state.sessions)
    const fired = dueReminders({ spent, budget, remindAtPercent: config.remindAtPercent, reminded: state.reminded })
    if (fired.length > 0) {
      for (const percent of fired) {
        state.reminded.push(percent)
        logger.info('remind ' + percent + '% spent=' + spent + ' cycle=' + state.cycle)
        void notifyTelegram(remindText(percent, spent, budget))
      }
      persist()
      // 最高档提醒完毕：累计清零，开新周期（主人定调「提醒完毕之后累计清零」）
      const maxPercent = maxRemindPercent(config.remindAtPercent)
      if (cycleResetDue(spent, budget, maxPercent)) {
        startNewCycle('最高档 ' + maxPercent + '% 提醒完毕，自动清零开新周期')
      }
    }
    return fired
  }

  // ---------- Telegram 主动通知（复用 outbound 工具；不可用则静默） ----------
  async function notifyTelegram(text: string): Promise<void> {
    if (!config.telegramNotify) return
    try {
      const tg = (ctx as any).tools?.get?.('telegram_send')
      if (typeof tg?.execute === 'function') {
        const r = await tg.execute({ text, plain: false })
        if (r?.ok) logger.info('telegram 提醒已发')
        else logger.warn('telegram 提醒发送结果: ' + JSON.stringify(r))
      }
    } catch (e) { logger.warn('telegram 提醒失败: ' + String(e)) }
  }

  // ---------- 监听 agent/status：idle 时记账 + 插话 ----------
  ctx.on('agent/status', (payload: any) => {
    const agent = payload.agent as Agent
    const status = payload.status as string
    if (status !== 'idle') return
    try {
      const projections = (ctx as unknown as { sessionProjections: { snapshot(session: unknown): ProjectionSnapshot } }).sessionProjections
      const snapshot = projections.snapshot(agent.session)
      const usageTotal = usageTotalOf(snapshot)
      const fired = record(agent.id, usageTotal)
      // 插话提醒（达档位时在会话里也提示主人）：用**实际触发的最高档位**与**生效预算**，
      // 与 telegram 文本同源（修前此处固定取 config.remindAtPercent 末位 + config.budgetTokens，
      // 会出现「弹 50% 档却写 100%」「显示配置预算而非 token_budget_set 的预算」）
      if (fired.length > 0) {
        const percent = Math.max(...fired)
        try {
          agent.send(
            createUserMessage({
              content: [{ type: 'text', text: remindText(percent, totalSpent(state.sessions), effective()) }],
              source: { kind: 'dsh-agent-token-budget' },
            }),
            'next-turn',
            true,
          )
        } catch { /* 插话失败静默 */ }
      }
    } catch (e) { logger.warn('记账失败: ' + String(e)) }
  })

  // ---------- 工具：token_budget_status（周期模式） ----------
  ctx.tools.register(defineTool({
    name: 'token_budget_status',
    description: '查询 Token 预算状态（周期模式）：本周期累计已用、预算、剩余、档位提醒、活跃/历史会话分解、周期号。只有输入预算后（token_budget_set 或配置）才统计；提醒完毕自动清零开新周期。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, tracking: { type: 'boolean' }, spentTokens: { type: 'number' }, budgetTokens: { type: 'number' }, remainingTokens: { type: 'number' }, percentUsed: { type: 'number' }, sessionsTracked: { type: 'number' }, activeSpent: { type: 'number' }, staleSpent: { type: 'number' }, cycle: { type: 'number' }, cycleStartedAt: { type: 'string' }, reminded: { type: 'array', items: { type: 'number' } } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: (v.tracking ? '周期#' + v.cycle + ' 已用 ' + (v.spentTokens / 1e6).toFixed(1) + 'M / ' + (v.budgetTokens / 1e6).toFixed(0) + 'M (' + v.percentUsed + '%) 活跃=' + (v.activeSpent / 1e6).toFixed(1) + 'M 历史=' + (v.staleSpent / 1e6).toFixed(1) + 'M 会话=' + v.sessionsTracked + ' 提醒=' + JSON.stringify(v.reminded) : '未输入预算（未统计）——请用 token_budget_set 输入预算后开始统计') }],
    },
    async execute() {
      return budgetStatus({ state, configBudget: config.budgetTokens, activeIds: activeSessionIds() }) as never
    },
  }))

  // ---------- 工具：token_budget_set（输入预算 → 开始统计） ----------
  ctx.tools.register(defineTool({
    name: 'token_budget_set',
    description: '输入/更新 Token 预算并开新统计周期（主人定调：只有输入预算后才统计）。执行后累计清零、档位重置，从当下起统计各会话增量消耗；预算保留到再次 set。',
    parameters: {
      budgetTokens: { type: 'number', description: '预算总额（tokens，>0；如 500000000 = 5 亿）', required: true },
      reason: { type: 'string', description: '设定原因（决策留痕，建议填写）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, budgetTokens: { type: 'number' }, cycle: { type: 'number' }, note: { type: 'string' } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: '预算已设定 ' + (v.budgetTokens / 1e6).toFixed(0) + 'M，周期#' + v.cycle + ' 开始统计' }],
    },
    async execute(args: { budgetTokens: number; reason?: string }) {
      const budget = Math.max(1, Math.floor(args.budgetTokens))
      state.budgetTokens = budget
      startNewCycle('token_budget_set ' + (args.reason ? '（' + args.reason + '）' : ''))
      logger.info('预算已设定 budget=' + budget + ' cycle=' + state.cycle)
      return { ok: true, budgetTokens: budget, cycle: state.cycle, note: '预算 ' + budget + ' 已生效，周期#' + state.cycle + ' 开始统计' }
    },
  }))

  // ---------- 工具：token_budget_reset（手动清零/清理） ----------
  ctx.tools.register(defineTool({
    name: 'token_budget_reset',
    description: '清零 Token 预算统计：scope=all 开新周期（累计清零）；scope=session 删除指定会话统计；scope=stale 清理已不在活跃列表的死会话统计（历史虚高一键清理）。预算额保留。',
    parameters: {
      scope: { type: 'string', description: 'all=全部清零开新周期 / session=指定会话 / stale=清理死会话', required: true },
      sessionId: { type: 'string', description: 'scope=session 时的目标会话 id' },
      reason: { type: 'string', description: '清理原因（决策留痕，建议填写）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, removed: { type: 'number' }, kept: { type: 'number' }, cycle: { type: 'number' }, note: { type: 'string' } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: '已清理 ' + v.removed + ' 条，保留 ' + v.kept + ' 条' + (v.cycle !== undefined ? '，周期#' + v.cycle : '') }],
    },
    async execute(args: { scope: string; sessionId?: string; reason?: string }) {
      const scope = args.scope ?? 'all'
      logger.info('reset scope=' + scope + (args.sessionId ? ' session=' + args.sessionId : '') + (args.reason ? ' reason=' + args.reason : ''))
      if (scope === 'all') {
        const cycle = state.cycle + 1
        startNewCycle('token_budget_reset all' + (args.reason ? '（' + args.reason + '）' : ''))
        return { ok: true, removed: 0, kept: 0, cycle, note: '已清零开新周期 #' + cycle }
      }
      if (scope === 'session') {
        if (!args.sessionId) return { ok: false, note: 'scope=session 需要 sessionId' }
        const existed = args.sessionId in state.sessions || args.sessionId in state.baseline
        delete state.sessions[args.sessionId]
        delete state.baseline[args.sessionId]
        persist()
        return { ok: true, removed: existed ? 1 : 0, kept: Object.keys(state.sessions).length, note: existed ? '已删除会话 ' + args.sessionId + ' 的统计' : '该会话无统计' }
      }
      if (scope === 'stale') {
        const active = activeSessionIds()
        let removed = 0
        for (const sid of Object.keys(state.sessions)) {
          if (!active.has(sid)) { delete state.sessions[sid]; delete state.baseline[sid]; removed += 1 }
        }
        persist()
        return { ok: true, removed, kept: Object.keys(state.sessions).length, note: '已清理 ' + removed + ' 个死会话统计' }
      }
      return { ok: false, note: 'scope 须为 all / session / stale' }
    },
  }))

  // 启动时打印一次状态（便于诊断）
  ctx.effect(function* () {
    logger.info('token-budget ready: budget=' + effective() + ' tracking=' + (effective() > 0) + ' cycle=' + state.cycle + ' tracked=' + Object.keys(state.sessions).length + ' spent=' + totalSpent(state.sessions))
  }, 'agent-token-budget lifecycle')
}

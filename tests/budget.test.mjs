/**
 * dsh-agent-llm-retry · Token 预算记账套件（纯函数，离线、无 IO）。
 *
 * 覆盖正常路径 + 失败/退化路径（损坏 state 文件、畸形字段、缺快照、NaN、除零、
 * 阈值边界、已提醒去重、幂等/无副作用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  budgetStatus, contributionOf, cycleResetDue, dueReminders, effectiveBudget, emptyBudgetState,
  isLegacyState, maxRemindPercent, normalizeState, remindText, splitSpentByActive, totalSpent, usageTotalOf,
} from '../lib/budget-pure.js'

const state = (sessions = {}, extra = {}) => ({ ...emptyBudgetState(), sessions, ...extra })

test('usageTotalOf: 四桶互斥合计', () => {
  assert.equal(usageTotalOf({ values: { tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 } } }), 100)
})

test('usageTotalOf: 退化输入——缺 values / 缺 tokenUsage / null / 字段非数值 全部按 0 计且不抛', () => {
  assert.equal(usageTotalOf(undefined), 0)
  assert.equal(usageTotalOf(null), 0)
  assert.equal(usageTotalOf({}), 0)
  assert.equal(usageTotalOf({ values: {} }), 0)
  assert.equal(usageTotalOf({ values: { tokenUsage: {} } }), 0)
  assert.equal(usageTotalOf({ values: { tokenUsage: { uncachedInputTokens: 'x', outputTokens: Number.NaN, cacheReadTokens: null } } }), 0)
  assert.equal(usageTotalOf({ values: { tokenUsage: { uncachedInputTokens: 5, outputTokens: 'x' } } }), 5, '部分坏字段只丢那一桶')
})

test('normalizeState: undefined/null → 空状态（无 issue）', () => {
  for (const v of [undefined, null]) {
    const r = normalizeState(v)
    assert.deepEqual(r.state, emptyBudgetState())
    assert.deepEqual(r.issues, [])
  }
})

test('normalizeState: 合法 state 逐字段保留（旧实现语义不变）', () => {
  const saved = {
    sessions: { s1: 100 }, baseline: { s1: 5 }, reminded: [100], budgetTokens: 123,
    cycle: 3, cycleStartedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z',
  }
  const r = normalizeState(saved)
  assert.deepEqual(r.state, saved)
  assert.deepEqual(r.issues, [])
  assert.deepEqual(saved.sessions, { s1: 100 }, '不得修改入参（纯函数）')
})

test('normalizeState: 失败路径——顶层非对象 / 数组 / 字符串 → 空状态 + issue（不崩）', () => {
  for (const v of [[], 'abc', 42, true]) {
    const r = normalizeState(v)
    assert.deepEqual(r.state, emptyBudgetState())
    assert.equal(r.issues.length, 1, `${JSON.stringify(v)} 应报一条 issue`)
    assert.match(r.issues[0], /顶层不是对象/)
  }
})

test('normalizeState: 失败路径——字段畸形逐个丢弃并报 issue（部分保留）', () => {
  const r = normalizeState({ sessions: 'not-an-object', baseline: { s1: 7 }, reminded: 'x', budgetTokens: 'nope', cycle: Number.NaN })
  assert.deepEqual(r.state.sessions, {}, 'sessions 畸形 → 空')
  assert.deepEqual(r.state.baseline, { s1: 7 }, 'baseline 合法 → 保留')
  assert.deepEqual(r.state.reminded, [])
  assert.equal(r.state.budgetTokens, 0)
  assert.equal(r.state.cycle, 0)
  assert.equal(r.state.cycleStartedAt, '')
  assert.equal(r.issues.length, 2, 'sessions 与 reminded 各报一条；数值字段（budgetTokens/cycle）按 0 回落不报 issue')
})

test('normalizeState: 退化输入——数值字符串可接受，非有限值（NaN/Infinity）丢弃', () => {
  const r = normalizeState({ sessions: { a: '100', b: Number.NaN, c: Number.POSITIVE_INFINITY, d: 5 }, reminded: [100, Number.NaN, '50', 0] })
  assert.deepEqual(r.state.sessions, { a: 100, d: 5 })
  assert.deepEqual(r.state.reminded, [100, 0], '非数值项被滤掉')
})

test('isLegacyState: 有 sessions 无 baseline → 旧格式（需清零）', () => {
  assert.equal(isLegacyState(state({ s1: 1 })), true)
  assert.equal(isLegacyState(state({ s1: 1 }, { baseline: { s1: 0 } })), false)
  assert.equal(isLegacyState(emptyBudgetState()), false, '全新状态不是旧格式（不该被清零逻辑打扰）')
})

test('effectiveBudget: 运行态优先，回落配置，双 0 → 0（不统计）', () => {
  assert.equal(effectiveBudget(123, 500), 123)
  assert.equal(effectiveBudget(0, 500), 500)
  assert.equal(effectiveBudget(0, 0), 0)
  assert.equal(effectiveBudget(-5, 500), 500, '负预算视为未设定')
  assert.equal(effectiveBudget(0, -1), 0, '配置也非法 → 0')
})

test('totalSpent: 求和；空 → 0；坏值按 0 计（不产出 NaN）', () => {
  assert.equal(totalSpent({ a: 1, b: 2 }), 3)
  assert.equal(totalSpent({}), 0)
  assert.equal(totalSpent({ a: 1, b: Number.NaN, c: undefined, d: 2 }), 3)
})

test('contributionOf: 增量；退化输入——负增量夹到 0（会话用量回退/重置）', () => {
  assert.equal(contributionOf(100, 40), 60)
  assert.equal(contributionOf(40, 40), 0)
  assert.equal(contributionOf(10, 40), 0, '负增量不得让累计倒退')
})

test('maxRemindPercent: 取最高有效档位；全非法/空 → 0', () => {
  assert.equal(maxRemindPercent([50, 100]), 100)
  assert.equal(maxRemindPercent([0, -1, 80]), 80)
  assert.equal(maxRemindPercent([0, -1]), 0)
  assert.equal(maxRemindPercent([]), 0, '空数组不得产出 -Infinity')
})

test('dueReminders: 正常路径——达阈值触发，多档同时达按配置顺序返回', () => {
  const args = { spent: 1000, budget: 1000, remindAtPercent: [50, 80, 100], reminded: [] }
  assert.deepEqual(dueReminders(args), [50, 80, 100])
  assert.deepEqual(dueReminders({ ...args, spent: 600 }), [50])
})

test('dueReminders: 失败/退化路径——未达阈值 / 已提醒 / 非正档位 / 空配置 一律不触发', () => {
  assert.deepEqual(dueReminders({ spent: 499, budget: 1000, remindAtPercent: [50], reminded: [] }), [], '未达阈值')
  assert.deepEqual(dueReminders({ spent: 1000, budget: 1000, remindAtPercent: [100], reminded: [100] }), [], '已提醒不得重复')
  assert.deepEqual(dueReminders({ spent: 1000, budget: 1000, remindAtPercent: [0, -50], reminded: [] }), [], '非正档位跳过')
  assert.deepEqual(dueReminders({ spent: 1000, budget: 1000, remindAtPercent: [], reminded: [] }), [])
})

test('dueReminders: 边界——阈值四舍五入取整（budget*percent/100 的小数）', () => {
  // 333 * 50 / 100 = 166.5 → round = 167（不是 166/166.5）
  assert.deepEqual(dueReminders({ spent: 167, budget: 333, remindAtPercent: [50], reminded: [] }), [50])
  assert.deepEqual(dueReminders({ spent: 166, budget: 333, remindAtPercent: [50], reminded: [] }), [])
})

test('cycleResetDue: 最高档达成才清零；无档位（0）永不清零', () => {
  assert.equal(cycleResetDue(1000, 1000, 100), true)
  assert.equal(cycleResetDue(999, 1000, 100), false)
  assert.equal(cycleResetDue(1000, 1000, 0), false)
})

test('remindText: 含档位与 M 量级；预算 0 不产出 NaN/Infinity 文案', () => {
  const t = remindText(100, 5e8, 5e8)
  assert.match(t, /500\.0M \/ 500M/)
  assert.match(t, /（100%）/)
  assert.equal(/NaN|Infinity/.test(remindText(50, 0, 0)), false)
})

test('splitSpentByActive: 活跃/历史分解与计数；空状态', () => {
  const r = splitSpentByActive({ a: 10, b: 20, c: 30 }, new Set(['a', 'c']))
  assert.deepEqual(r, { active: 40, stale: 20, activeCount: 2, staleCount: 1 })
  assert.deepEqual(splitSpentByActive({}, new Set()), { active: 0, stale: 0, activeCount: 0, staleCount: 0 })
})

test('budgetStatus: 未输入预算 → tracking=false 且 percentUsed=0（不除零）', () => {
  const s = budgetStatus({ state: state({ a: 100 }), configBudget: 0, activeIds: new Set(['a']) })
  assert.equal(s.tracking, false)
  assert.equal(s.percentUsed, 0)
  assert.equal(s.budgetTokens, 0)
  assert.equal(s.remainingTokens, 0)
})

test('budgetStatus: 正常路径——剩余量夹到 0、百分比两位小数、活跃/历史分解', () => {
  const s = budgetStatus({ state: state({ a: 750, dead: 400 }, { budgetTokens: 1000 }), configBudget: 500, activeIds: new Set(['a']) })
  assert.equal(s.spentTokens, 1150)
  assert.equal(s.budgetTokens, 1000, '运行态预算优先于配置')
  assert.equal(s.remainingTokens, 0, '超支不得为负')
  assert.equal(s.percentUsed, 115)
  assert.equal(s.sessionsTracked, 2)
  assert.equal(s.activeSpent, 750)
  assert.equal(s.staleSpent, 400)
})

test('budgetStatus: 纯函数/不可变——返回的 reminded 是拷贝，改它不影响 state（幂等投影）', () => {
  const st = state({}, { reminded: [50] })
  const a = budgetStatus({ state: st, configBudget: 100, activeIds: new Set() })
  a.reminded.push(999)
  assert.deepEqual(st.reminded, [50], '返回值与 state 不共享数组')
  assert.deepEqual(budgetStatus({ state: st, configBudget: 100, activeIds: new Set() }).reminded, [50])
})

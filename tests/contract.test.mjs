/**
 * dsh-agent-llm-retry · 静态不变量守卫（回归/尸体测试）。
 *
 * 两条**本插件自己的**不变量（不是从别的插件照抄的）：
 *
 * ① **Waterfall 监听器必须无条件放行**（AGENTS §`agent/request-error` 铁律 + 插件头部注释）：
 *    本插件在扩展点上 `prepend` 注册，一旦某条分支吞掉 `next()`，官方 llm-retry 执行器就永远不跑
 *    ——重试静默消失，而日志一片正常。守卫：监听器体内必须存在顶层（非嵌套分支里的）`return next()`。
 *
 * ② **提醒文案与生效预算同源**：`remindText` 的第三参必须是在生效的 `effective()`，
 *    不得写 `config.budgetTokens`。修前实现写死 `config.budgetTokens`，于是
 *    `token_budget_set` 设定过新预算后，会话里弹出的提醒仍显示**配置里的旧预算**
 *    （阈值按新预算算、文案按旧预算写 = 同一条消息里两个预算）。
 *
 * ② 用**尸体样本**证明检测器真的会抓：把修前那一行原样喂给检测函数，必须被判为违规。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const budgetSrc = readFileSync(join(root, 'src', 'budget.ts'), 'utf8')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

/** 检测器：所有 remindText(…) 调用（同行取到行尾，避免嵌套括号截断）的第三参里出现 config.budgetTokens 即违规。 */
function findBudgetTextMismatch(source) {
  const offenders = []
  for (const line of source.split('\n')) {
    const i = line.indexOf('remindText(')
    if (i === -1) continue
    const call = line.slice(i).trim()
    if (/config\.budgetTokens/.test(call)) offenders.push(call)
  }
  return offenders
}

test('不变量②：remindText 的预算参数不得写 config.budgetTokens（必须用 effective()）', () => {
  const offenders = findBudgetTextMismatch(budgetSrc)
  assert.deepEqual(offenders, [], `提醒文案与生效预算必须同源，违规调用：\n${offenders.join('\n')}`)
  assert.ok(/remindText\(/.test(budgetSrc), '守卫前提：源码里确实存在 remindText 调用（否则本守卫空转）')
})

test('不变量②·尸体样本：修前那一行必须被检测器抓到（证明守卫不是空转）', () => {
  // 修前原文（commit 前 src/budget.ts）：
  //   const lastPercent = config.remindAtPercent[config.remindAtPercent.length - 1] ?? 100
  //   ... text: remindText(lastPercent, totalSpent(), config.budgetTokens)
  const corpse = "text: remindText(lastPercent, totalSpent(), config.budgetTokens)"
  const clean = 'text: remindText(percent, totalSpent(state.sessions), effective())'
  assert.deepEqual(findBudgetTextMismatch(corpse), ['remindText(lastPercent, totalSpent(), config.budgetTokens)'], '尸体样本必须被抓出')
  assert.deepEqual(findBudgetTextMismatch(clean), [], '修后的写法必须是干净的')
})

/** 取出 `agent/request-error` 监听器体（从回调开头到最后闭括号之前）。 */
function handlerBody(source) {
  const start = source.indexOf("ctx.on('agent/request-error'")
  assert.ok(start > -1, '前提：监听器存在（否则本守卫空转）')
  const end = source.indexOf('}, { prepend: true })', start)
  assert.ok(end > start, '前提：监听器形态为 ctx.on(…, { prepend: true })')
  return source.slice(start, end)
}

/** 无条件放行判据：回调体的**最后一条语句**必须是 `return next()`（被 if 包住时末条语句会变成 `}`）。 */
function releasesUnconditionally(source) {
  const lines = handlerBody(source).trimEnd().split('\n')
  return lines[lines.length - 1].trim() === 'return next()'
}

test('不变量①：agent/request-error 监听器必须无条件 `return next()` 放行官方执行器', () => {
  assert.equal(releasesUnconditionally(indexSrc), true, '回调体末条语句必须是 return next()（任何分支都不能吞掉放行）')
  assert.match(indexSrc.slice(indexSrc.indexOf("ctx.on('agent/request-error'"), indexSrc.indexOf("ctx.on('agent/request-error'") + 3000), /prepend: true/, '策略升级器必须 prepend（先于官方执行器）')
})

test('不变量①·尸体样本：把放行语句塞进 if 分支即被守卫抓到（末条语句变成 `}`）', () => {
  const corpse = [
    "ctx.on('agent/request-error', async (payload, next) => {",
    '  if (payload) {',
    '    return next()',
    '  }',
    '}, { prepend: true })',
  ].join('\n')
  assert.equal(releasesUnconditionally(corpse), false, '分支内的 next() 不得被当作无条件放行')
})

test('入口契约：产物导出 name/inject/apply，且 inject 含策略升级所需的 llm 服务', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'agent-llm-retry')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.inject.includes('llm'), '策略升级读 ctx.llm/扩展点，必须声明 llm 依赖（cordis 严格代理）')
  assert.ok(mod.inject.includes('tools'), '工具注册需要 tools')
})

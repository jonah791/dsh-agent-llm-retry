/**
 * dsh-agent-llm-retry · 重试策略决策套件（纯函数，离线）。
 *
 * 本插件的**唯一职责**就是这段决策：把 provider 的 normal 策略升级到配置的 maxRetries。
 * 覆盖正常路径 + 失败/退化路径（畸形策略、非数值 maxRetries、空/非数组 retryableCodes、
 * 时钟/配置倒挂）+ 不降级性质。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RETRYABLE_CODES, buildPolicy, decidePolicyUpgrade,
} from '../lib/retry-pure.js'

const CFG = { maxRetries: 20, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }

test('buildPolicy: 字段照抄配置，可重试码拷贝一份（外部改数组不影响已建策略）', () => {
  const codes = ['RATE_LIMIT']
  const p = buildPolicy(CFG, codes)
  assert.deepEqual(p, {
    mode: 'normal', maxRetries: 20, retryableCodes: ['RATE_LIMIT'],
    initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1,
  })
  codes.push('SERVER')
  assert.deepEqual(p.retryableCodes, ['RATE_LIMIT'], '策略不得被调用方后续修改污染')
  assert.notEqual(p.retryableCodes, codes)
})

test('decidePolicyUpgrade: 无策略（undefined/null）→ 注入默认策略（官方默认码）', () => {
  for (const policy of [undefined, null]) {
    const d = decidePolicyUpgrade(policy, CFG)
    assert.equal(d.action, 'inject')
    assert.equal(d.policy?.maxRetries, 20)
    assert.deepEqual(d.policy?.retryableCodes, [...DEFAULT_RETRYABLE_CODES])
  }
})

test('decidePolicyUpgrade: 正常路径——官方默认 maxRetries=2 → 升级到 20，保留原可重试码', () => {
  const d = decidePolicyUpgrade({ mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER', 'TIMEOUT'], initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 }, CFG)
  assert.equal(d.action, 'upgrade')
  assert.equal(d.fromMaxRetries, 2)
  assert.equal(d.policy?.maxRetries, 20)
  assert.deepEqual(d.policy?.retryableCodes, ['SERVER', 'TIMEOUT'], '原可重试码必须保留')
  assert.equal(d.policy?.initialDelayMs, 500, '退避参数取配置值')
})

test('decidePolicyUpgrade: 退化输入——retryableCodes 空数组/非数组/缺失 一律回落官方默认码', () => {
  const base = { mode: 'normal', maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
  for (const codes of [[], undefined, null, 'RATE_LIMIT', 42, {}]) {
    const d = decidePolicyUpgrade({ ...base, retryableCodes: codes }, CFG)
    assert.equal(d.action, 'upgrade', `codes=${JSON.stringify(codes)} 仍应升级`)
    assert.deepEqual(d.policy?.retryableCodes, [...DEFAULT_RETRYABLE_CODES], `codes=${JSON.stringify(codes)} 应回落默认码`)
  }
})

test('decidePolicyUpgrade: 不降级——maxRetries 等于/大于配置一律 noop', () => {
  const mk = (maxRetries) => ({ mode: 'normal', maxRetries, retryableCodes: ['SERVER'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 })
  assert.equal(decidePolicyUpgrade(mk(20), CFG).action, 'noop', '等于配置：不动')
  assert.equal(decidePolicyUpgrade(mk(99), CFG).action, 'noop', '大于配置：**绝不降级**（官方更宽松时减小重试是危险的）')
  assert.equal(decidePolicyUpgrade(mk(99), CFG).policy, undefined, 'noop 不得带策略（调用方据此不写 payload）')
})

test('decidePolicyUpgrade: always 模式 / 未知 mode 一律 noop', () => {
  for (const policy of [{ mode: 'always' }, {}, { mode: 'custom', maxRetries: 1 }, { maxRetries: 1 }]) {
    const d = decidePolicyUpgrade(policy, CFG)
    assert.equal(d.action, 'noop', `${JSON.stringify(policy)} 必须不升级`)
  }
})

test('decidePolicyUpgrade: 失败路径——normal 但 maxRetries 非数值/NaN/Infinity 不得升级', () => {
  for (const maxRetries of ['2', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = decidePolicyUpgrade({ mode: 'normal', maxRetries, retryableCodes: ['SERVER'] }, CFG)
    assert.equal(d.action, 'noop', `maxRetries=${String(maxRetries)} 必须判为畸形并放行`)
  }
})

test('decidePolicyUpgrade: 边界——maxRetries=0（禁用重试）也走升级（0 < 20）', () => {
  const d = decidePolicyUpgrade({ mode: 'normal', maxRetries: 0, retryableCodes: ['SERVER'] }, CFG)
  assert.equal(d.action, 'upgrade')
  assert.equal(d.fromMaxRetries, 0)
})

test('decidePolicyUpgrade: 性质——非 noop 时结果 maxRetries 恒等于配置值（不引入第三个数）', () => {
  for (let maxRetries = 0; maxRetries <= 40; maxRetries += 1) {
    const d = decidePolicyUpgrade({ mode: 'normal', maxRetries, retryableCodes: ['SERVER'] }, CFG)
    if (d.action === 'noop') assert.ok(maxRetries >= CFG.maxRetries, `noop 只应发生在 >= 配置时（实际 ${maxRetries}）`)
    else assert.equal(d.policy?.maxRetries, CFG.maxRetries)
  }
})

test('decidePolicyUpgrade: 纯函数——同输入同输出（幂等，不读外部状态）', () => {
  const policy = { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'] }
  const a = decidePolicyUpgrade(policy, CFG)
  const b = decidePolicyUpgrade(policy, CFG)
  assert.deepEqual(a, b)
  assert.deepEqual(policy, { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'] }, '不得修改入参')
})

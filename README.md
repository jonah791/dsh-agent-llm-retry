<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: LLM 运维一体化插件：模型请求自动多次重试（策略升级 maxRetries 20）+ Token 预算跟踪（token_budget_* 工具，合并自 dsh-agent-token-budget）
  inject: 'tools','llm','sessionProjections','sessions'
  tools: llm_retry_status,token_budget_*
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-llm-retry

模型请求自动多次重试：在 agent/request-error 扩展点把 retryPolicy 升级为 maxRetries 20（默认），配合官方 llm-retry 执行器实现指数退避重试

## 生态

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）DSH 插件生态——21 个自研插件按生命/认知/感知/行动/通信/治理/呈现七层组织。


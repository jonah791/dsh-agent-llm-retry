# dsh-agent-llm-retry

模型请求自动多次重试：在 agent/request-error 扩展点把 retryPolicy 升级为 maxRetries 20（默认），配合官方 llm-retry 执行器实现指数退避重试

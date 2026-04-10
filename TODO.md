# Chaya Next — 待办

## 1. 自驱思考（Primag / 后端）

- 当前：基本设置里为 **stub**（开关禁用、说明文案）；运行时未接入离线调度。
- 方向：与 `internal/harness/runtime/offline.go`、`PrimaryAgent` 调度、以及后端配置模型对齐，明确触发间隔、主题、记忆触发等语义后再实现。

## 2. 真正面向聊天记录的 topology 构建

- 当前：`agent_topology` 可由 `Consolidate` 从 **traces** 推演；`POST /api/agents/{id}/topology/rebuild` 仍为 **TODO**；Consult 侧为关键词命中路径。
- 方向：
  - 从 **会话消息流**（按 `conv_id` / agent）抽取可学习信号，增量更新图（意图、边权、路径）。
  - 打通 **rebuild** → 异步 Consolidate（或独立 worker），并定义与聊天记录的对齐策略（采样、隐私、合并频率）。

## 3. 媒体创作台 — 低优先级

- [ ] `/api/media/outputs/{id}/file` 公开端点加签名验证（HMAC sig + expiry），防止无鉴权访问用户生成图片
- [ ] 前端 `MediaCreatorPage` / `AttachmentMenu` 清理 `getOutputFileUrl` 回退逻辑，HMR 全面生效后可移除 `/file` 回退路径

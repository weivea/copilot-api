# Copilot `/responses` API Support — Design

**Date:** 2026-04-28
**Status:** Draft (awaiting user review)

## Problem

GitHub Copilot 的 `/models` 接口返回了像 `gpt-5.5` 这样的模型，但调用 `/chat/completions` 时上游返回：

```
{"error":{"message":"model \"gpt-5.5\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}
```

原因是这些模型只在 Copilot 的 `/responses` 端点（OpenAI Responses API 协议）上开放，而本项目目前只对接 `/chat/completions` 和 `/embeddings`。

## Goals

1. **对外暴露 OpenAI 兼容的 `/v1/responses` 端点**，让原生使用 Responses API 的客户端可用。
2. **对 `/chat/completions` 和 `/v1/messages` 入口做透明 fallback**，让 Claude Code 等只会发 Chat Completions / Anthropic Messages 协议的客户端也能用 Responses-only 模型（如 `gpt-5.5`）。
3. **零（或极少）首次调用失败**：通过启动时扫描 `/models` 自动生成白名单，配合运行时探测兜底。

## Non-Goals

- 不实现 Copilot 服务端会话状态（`previous_response_id` / `store: true`）——proxy 始终无状态。
- 不做反向"Responses → Chat Completions"翻译给那些只能听懂 Chat 协议的客户端访问 `/v1/responses`（YAGNI）。
- 不持久化白名单到磁盘。

---

## Architecture

```
                                   ┌─ /chat/completions ──┐
客户端 ──► 路由层 (routes/) ──────►├─ /v1/messages ───────┤──► 调度判断 (responses-routing)
                                   └─ /v1/responses ──────┘            │
                                                                       │ 根据 model + 白名单 + 运行时缓存
                                                                       │
                                                          ┌────────────┴────────────┐
                                                          ▼                          ▼
                                            create-chat-completions.ts     create-responses.ts
                                                     │                              │
                                                     ▼                              ▼
                                          POST /chat/completions          POST /responses
                                            (Copilot upstream)              (Copilot upstream)
```

### 核心新增组件

| 组件 | 路径 | 职责 |
|---|---|---|
| Upstream service | `src/services/copilot/create-responses.ts` | 调 Copilot `/responses`，支持流式 / 非流式 |
| Routing module | `src/lib/responses-routing.ts` | 维护白名单 + 运行时缓存 |
| Translation module | `src/lib/translation/chat-to-responses.ts` | Chat Completions ↔ Responses 双向翻译 |
| Public route | `src/routes/responses/{route,handler}.ts` | 对外 `/v1/responses` 端点 |

### 修改点

- `src/server.ts`：注册 `/v1/responses` + `requireCopilotReady` 覆盖
- `src/services/copilot/create-chat-completions.ts`：调用前查 `shouldUseResponsesEndpoint`；命中时改走 responses 路径；上游报 `unsupported_api_for_model` 时自动加入运行时缓存并重试
- `src/lib/token.ts`（或缓存模型处）：成功写 `state.models` 之后调 `rebuildWhitelistFromModels`
- `src/routes/admin/models.ts` + `frontend/src/pages/Models.tsx`：附加 `routedViaResponses` 字段并显示 badge（**可选，非阻塞**）
- `README.md`：新增 Responses API 章节

---

## Routing 判定逻辑

### 模块接口

```ts
// src/lib/responses-routing.ts
let staticWhitelist: Set<string> = new Set()  // 启动 / refresh 时从 /models 推断
let runtimeCache: Set<string> = new Set()     // 运行时探测命中后写入

export function shouldUseResponsesEndpoint(modelId: string): boolean
export function rebuildWhitelistFromModels(models: Model[]): void
export function recordResponsesOnlyModel(modelId: string): void
```

### 白名单生成规则（`rebuildWhitelistFromModels`）

按优先级判断每个 model：

1. **明确字段**：`capabilities.type === "responses"` → 命中
2. **保守启发式（可选，仅在第 0 步抓包后确认有必要才启用）**：`capabilities.type` 不在 `{"chat", "embeddings", "completion"}` 之列 → 命中
3. 其它都不命中

> ⚠️ **不确定性**：当前没法证实 Copilot `/models` 一定会返回 `type: "responses"`。**实现阶段第 0 步必须先抓一次真实 `/models` 输出**确认。如果 Copilot 完全不暴露此类字段，规则 1 永不命中，白名单退化为空，靠运行时缓存兜底（首次调用某新模型会失败一次）。

### 触发时机

在已有的"成功写入 `state.models`"之后立即调用 `rebuildWhitelistFromModels(state.models.data)`。token 自动刷新会刷新模型列表 → 白名单跟着刷新。

### 判定函数

```ts
shouldUseResponsesEndpoint(modelId) =
  staticWhitelist.has(modelId) || runtimeCache.has(modelId)
```

### 运行时探测兜底

`create-chat-completions.ts` catch 上游错误，若 `error.code === "unsupported_api_for_model"`：

1. `recordResponsesOnlyModel(modelId)` 加入 `runtimeCache`
2. 自动调 `create-responses.ts` 重试
3. 经翻译层转回 Chat Completions 格式返回

⚠️ **流式约束**：fallback 只能在"上游首字节前"完成。一旦上游已经开始返回 SSE，错误只能透传。

---

## Translation Layer

### `chatRequestToResponses(req)` —— 请求翻译

| Chat Completions 字段 | → | Responses 字段 |
|---|---|---|
| `messages[role:"system"].content` | → | 顶层 `instructions`（多个 system 拼接） |
| `messages[role:"user"\|"assistant"]` | → | `input[].role + content[{type:"input_text", text}]` |
| `messages[role:"tool", tool_call_id, content]` | → | `input[{type:"function_call_output", call_id, output}]` |
| `messages[role:"assistant"].tool_calls[]` | → | `input[{type:"function_call", call_id, name, arguments}]` |
| 多模态 `content[{type:"image_url"}]` | → | `content[{type:"input_image", image_url}]` |
| `model` / `stream` / `temperature` / `top_p` / `stop` | → | 同名 |
| `max_tokens` | → | `max_output_tokens` |
| `tools[{type:"function", function:{name,description,parameters}}]` | → | `tools[{type:"function", name, description, parameters}]`（拍平 function 字段） |
| `tool_choice` | → | 同名 |
| `reasoning_effort`（扩展字段） | → | `reasoning: {effort}` |

**强制**：`store: false`。**忽略**：`previous_response_id`。

### `responsesToChatResponse(resp)` —— 非流式响应翻译

```
resp.id            → 合成 chatcmpl-xxx
resp.model         → model
resp.output[]      → 单个 choices[0]:
  - type:"message"      → message.content (拼接所有 output_text)
  - type:"function_call"→ message.tool_calls[]
  - type:"reasoning"    → message.reasoning_content (扩展字段)
resp.usage         → usage (input_tokens→prompt_tokens, output_tokens→completion_tokens)
resp.status        → finish_reason
                     ("completed"→"stop", "incomplete"→"length", "failed"→抛错)
```

### `responsesStreamToChatStream(upstream)` —— 流式 SSE 翻译

| Responses 事件 | → | Chat Completions chunk |
|---|---|---|
| `response.created` | → | 第一个 chunk：`choices[0].delta.role = "assistant"` |
| `response.output_text.delta` | → | `choices[0].delta.content = delta` |
| `response.function_call_arguments.delta` | → | `choices[0].delta.tool_calls[{index, function:{arguments: delta}}]` |
| `response.output_item.added` (function_call) | → | `choices[0].delta.tool_calls[{index, id:call_id, function:{name}}]` |
| `response.reasoning_summary_text.delta` | → | `choices[0].delta.reasoning_content = delta` |
| `response.completed` | → | 最终 chunk：`finish_reason = "stop"` + `usage` |
| `response.failed` / `response.error` | → | 终止流并抛 HTTPError |
| 其它（`in_progress` / `content_part.added` 等） | → | 忽略 |

**实现风格**：`ReadableStream` + `TransformStream`，逐事件转换，不缓冲整流。

### `/v1/messages` 路径复用

`/v1/messages` 已经先翻译成 Chat Completions 格式再走下游 → fallback 在下游 service 层完成 → **零额外代码**自动覆盖该路径。

---

## 对外 `/v1/responses` 端点

`src/routes/responses/handler.ts` 行为：

1. zod 轻量校验请求体（必须有 `model` 和 `input`）
2. **强制 `store: false`**；若客户端传了 `previous_response_id` 直接 400 报错（"本代理不支持服务端会话状态"）
3. 调 `create-responses.ts` 转发
4. 流式：上游 SSE **原样转发**（事件名和 data 都不动）
5. 非流式：上游 JSON 原样返回
6. 错误：`forwardError(c, error)`

**为什么不做翻译**：客户端主动用 `/v1/responses` 就预期收 Responses 格式，原样转发最简单也最准。

---

## 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 上游 `/responses` 4xx/5xx | 包装成 `HTTPError` 由 `forwardError` 返回；保留原 error code |
| `/chat/completions` 路径 fallback 重试也失败 | 返回**第二次**（Responses 路径）的错误，日志记录"已尝试 fallback" |
| 流式请求 fallback | 仅在上游首字节前完成；流已开始则错误透传 |
| 翻译层未知 Responses 事件 | `consola.warn` 一行，忽略 |
| 翻译层未知 input/content type | 抛 `HTTPError(400)`，日志带原始 type |
| `state.models` 未 ready | `shouldUseResponsesEndpoint` 返回 `false`，由运行时探测兜底 |

---

## Testing

新增测试文件：

- `tests/translation-chat-to-responses.test.ts`
  - 基础 user-only 请求
  - 含 system 消息
  - 含 tool_calls + tool result（多轮工具调用）
  - 多模态（图片）
  - 流式（mock SSE 序列驱动 TransformStream）
  - 错误事件（`response.failed`）
- `tests/responses-routing.test.ts`
  - 白名单生成规则各分支
  - 运行时缓存写入与命中
  - 模型列表 refresh 后白名单同步
- `tests/responses-endpoint.test.ts`
  - 非流式正常请求
  - 流式 SSE 透传
  - 上游错误 forwardError
  - `previous_response_id` 拒绝

服务测试沿用现有约定：mock `globalThis.fetch`。

---

## Files

**新增**：
- `src/services/copilot/create-responses.ts`
- `src/lib/responses-routing.ts`
- `src/lib/translation/chat-to-responses.ts`
- `src/routes/responses/route.ts`
- `src/routes/responses/handler.ts`
- `tests/translation-chat-to-responses.test.ts`
- `tests/responses-routing.test.ts`
- `tests/responses-endpoint.test.ts`

**修改**：
- `src/server.ts` — 注册 `/v1/responses`
- `src/services/copilot/create-chat-completions.ts` — 接 routing + 错误兜底
- `src/lib/token.ts`（或模型缓存写入处）— 调 `rebuildWhitelistFromModels`
- `src/routes/admin/models.ts` — 附加 `routedViaResponses` 字段（可选）
- `frontend/src/pages/Models.tsx` — 路由 badge 列（可选）
- `README.md` — 新增 Responses API 章节，含 curl + OpenAI SDK 示例 + 自动 fallback 说明

---

## 实现计划第 0 步（预研）

实现阶段第 0 步必须先用真实 Copilot token 抓：

1. **`/models` 输出**：确认 `gpt-5.5` 的 `capabilities.type` 实际值，验证白名单规则可行性
2. **最小 `/responses` 请求**：用 `gpt-5.5` 跑通一次最小请求（流式 + 非流式各一次），记录真实请求 / 响应 / SSE 序列，验证翻译层假设

如果第 0 步发现 OpenAI 公开协议与 Copilot 实际有出入，翻译表回来调整。

---

## Out of Scope

- 服务端会话状态（`previous_response_id` / `store: true`）
- 内建工具（`web_search` / `file_search` / `code_interpreter`）的端到端支持——透传上游能力，但不在本期保证可用
- 持久化白名单到磁盘
- 反向 Responses → Chat Completions 翻译

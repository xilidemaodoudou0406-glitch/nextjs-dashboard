# RAG 对话记忆实现记录

本文记录本项目从“每次上传并发送全部历史”改造成“最近上下文 + RAG 长期记忆”的设计、数据边界、运维命令和验证方法。

## 改造目标

改造前，主对话由浏览器把完整 `messages` 数组提交给 `/api/chat`，服务端再把完整数组交给模型。历史增长后会同时增加浏览器请求体、模型输入 Token、延迟和费用。

改造后遵守以下原则：

1. 浏览器只提交最新一条消息；
2. 完整消息仍保存在 `messages`，用于历史展示和审计；
3. 服务端从数据库读取最近 16 条原文；
4. 服务端最多检索 5 条候选记忆，过滤后最多注入 3 条；
5. 主对话只读取自身，分支只读取“父对话截至锚点 + 分支自身”；
6. Embedding 或向量检索失败时降级为最近上下文，不中断正常聊天；
7. 只有正常完成的文字问答才写入长期记忆。

## 最终数据流

```text
浏览器 useChat（保留完整 UI 消息）
        │
        │ POST /api/chat，仅最新用户消息
        ▼
认证、校验资源归属、幂等保存用户消息
        │
        ├──────────────┐
        ▼              ▼
读取最近 16 条      当前问题生成 1024 维向量
原始消息              │
        │              ▼
        │         pgvector 检索候选记忆
        │              │
        └──────┬───────┘
               ▼
     去重、相关度过滤、最多 3 条(一条指的是用户+ai的一轮问答)
               │
               ▼
   系统提示词 + 历史参考 + 最近消息
               │
               ▼
        DeepSeek 流式生成回答
               │
               ▼
       保存完整 assistant 消息
               │
               ▼
 一问一答生成向量并写入 conversation_memories
```

## 数据库迁移

迁移文件：`migrations/0004_add_conversation_memories.sql`

迁移会启用 `vector` 扩展，并创建 `conversation_memories`。一条记忆对应一条完整的 user/assistant 问答，核心字段包括：

- `user_id`：检索租户边界；
- `chat_id`：主对话或分支范围；
- `source_user_message_id`：来源用户消息；
- `source_assistant_message_id`：来源助手消息，同时作为幂等唯一键；
- `content`：注入模型的可读记忆文本；
- `embedding VECTOR(1024)`：语义向量；
- `embedding_model`：当前固定为 `text-embedding-v4`。

`messages` 是事实源，`conversation_memories` 是派生索引。换模型或损坏向量时，可以清空记忆表并从原始消息重新回填。

## Embedding 配置

服务端需要以下环境变量：

```env
DASHSCOPE_API_KEY=你的百炼API密钥
DASHSCOPE_BASE_URL=https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

真实 Key 只放在 `.env.local` 或部署平台的服务端环境变量中，不能使用 `NEXT_PUBLIC_` 前缀。

相关代码：

- `app/lib/ai/provider.ts`：固定模型 ID 和 1024 维；
- `app/lib/ai/embedding.ts`：统一调用 `embed()`，并校验返回维度；
- `app/lib/ai/memory.ts`：记忆格式化、保存和范围化检索；
- `app/lib/ai/context.ts`：最近消息、检索去重、阈值和系统提示词。

## 检索参数

当前常量位于 `app/lib/ai/context.ts`：

```text
RECENT_MESSAGE_LIMIT = 16
RETRIEVAL_CANDIDATE_LIMIT = 5
RETRIEVAL_RESULT_LIMIT = 3
MEMORY_SIMILARITY_THRESHOLD = 0.6
```

阈值 `0.6` 是初始值，应使用真实问题集评估后调整。低于阈值的候选不会强行注入；来源消息已在最近 16 条中的记忆也会去重。

## 分支隔离

分支查询不会复用主对话的无界结果。最近消息和向量记忆都遵守：

```text
父对话中 created_at/id 不晚于锚点的内容
+ 当前 branchId 自己的内容
```

锚点之后的主对话、其他分支和其他用户的数据均不会进入候选集合。所有 SQL 同时校验 `user_id`，不能只信任客户端传入的 `chatId`。

## 写入与失败降级

助手消息完成并成功入库后，`/api/chat` 才尝试生成记忆。以下情况不写记忆：

- 用户主动中断的回答；
- 模型错误产生的部分文本；
- 用户或助手没有可索引文字；
- 数据库角色、归属或状态校验失败。

保存记忆失败只记录服务端错误，不撤销聊天消息。检索失败则返回空记忆数组，模型继续使用最近 16 条消息回答。

## 历史数据回填

脚本：`scripts/backfill-conversation-memories.mjs`

只统计、不调用 Embedding、不写数据库：

```bash
pnpm db:backfill-memories -- --dry-run
```

正式回填：

```bash
pnpm db:backfill-memories
```

脚本每批处理 10 条相邻且完整的 user/assistant 问答，并通过 `ON CONFLICT DO NOTHING` 支持安全重跑。

## 部署步骤

新环境应按顺序执行：

```text
1. 配置 POSTGRES_URL、DASHSCOPE_API_KEY、DASHSCOPE_BASE_URL
2. 执行 pnpm db:migrate
3. 如有旧消息，先 dry-run 再执行 db:backfill-memories
4. 执行 pnpm check
5. 部署应用
```

数据库必须支持 pgvector。如果 `CREATE EXTENSION vector` 失败，应先在数据库服务商控制台启用扩展，不能绕过迁移创建不兼容的普通数组字段。

## 验证清单

- 浏览器网络面板中 `/api/chat` 请求只包含最新消息；
- 新问题可以正常流式回答；
- 正常回答后记忆表增加一行；
- 中断回答后记忆表不增加；
- 对较早事实提问时可以召回相关记忆；
- 无关问题不会强制加入低相似度记忆；
- 用户 A 无法检索用户 B 的记忆；
- 分支无法检索锚点之后的主对话内容；
- Embedding 服务不可用时仍能依靠最近消息回答。

## 当前边界与后续演进

当前使用“最近原文 + RAG 记忆”，尚未自动生成对话摘要。这样可以先解决绝大部分长上下文问题，并避免单一主对话摘要把锚点之后的信息泄露给旧分支。

如果未来需要摘要，应采用带截止消息 ID 的版本化摘要；分支只能选择截止位置不晚于锚点的摘要快照。不要只在 `chats` 上保存一个不断覆盖的摘要后直接给所有分支使用。

当单个检索范围达到大量记忆、精确扫描成为瓶颈后，再基于真实查询计划评估 HNSW 索引。早期数据量较小时，按用户和对话过滤后的精确余弦搜索更容易验证正确性。





## 几个模块

![e71ed054-f1b9-4e09-aa54-2eb64f32f231](file:///C:/Users/15421/Pictures/Typedown/e71ed054-f1b9-4e09-aa54-2eb64f32f231.png)



## 什么是`pgvector`

![ce5adcad-dbcd-4e26-9671-c5774e252be6](file:///C:/Users/15421/Pictures/Typedown/ce5adcad-dbcd-4e26-9671-c5774e252be6.png)

# RAG 对话记忆实现记录

本文描述当前代码中的对话记忆入库、检索、分支隔离和运行边界。完整聊天记录以 `messages` 为准，`conversation_memories` 是可重建的检索索引；它不是 PDF 或网页知识库。

## 数据流

```text
浏览器只提交最新用户消息
  → 服务端校验用户与 chat 归属
  → 读取最近消息（最多 16 条）
  → 需要消解指代时改写检索查询
  → pgvector 语义召回 + pg_trgm/精确技术词词法召回
  → RRF 融合、相关度过滤、去重、分支内事实覆盖
  → 注入最多 3 条较早记忆，与最近消息一起生成回答
  → 保存完整 assistant 消息
  → 仅对 completed 问答尝试提取并保存长期记忆
```

查询改写只影响检索，不替换用户原问题。普通独立问题不调用改写模型，并行读取最近消息和两路候选；需要改写的问题先读取最近消息，再并行执行两路检索。

## 入库与结构化记忆

`app/lib/ai/memory-extractor.ts` 先过滤“你好”“谢谢”“继续”等明显低价值轮次，再让模型判断一轮完整问答是否值得保存。每轮最多抽取 **一条** 自包含记忆，包含 `retrievalText`、`memoryType`、`memoryKey`、`keywords` 和 `importance`。这属于对话记忆抽取，不是对长文档做多 Chunk 切分。抽取失败时回退为低权重 `discussion` 记忆；模型判断不值得保存时则不建索引。

`app/lib/ai/memory.ts` 将完整问答保存为 `content`，供召回后作为历史参考；只对精简的 `retrievalText` 生成 `text-embedding-v4` 的 1024 维向量。插入时再次在 SQL 中验证用户、chat、消息角色和两条消息的 `completed` 状态，并以来源 assistant 消息 ID 防止重复入库。`interrupted` 回答保留为聊天记录，但不建长期记忆。记忆写入失败不会撤销已经保存的聊天消息。

同一 chat 内，新的非空 `memoryKey` 会将旧的同键记忆标记 `invalidated_at` 并记录 `superseded_by`；分支不会直接修改父对话的记忆。检索组装时，如果当前分支有同键候选，会排除继承来的父对话同键候选。

## 检索与上下文组装

`app/lib/ai/context.ts` 限制最近消息最多 16 条，每路检索最多取 20 条候选，最终最多注入 3 条记忆。`app/lib/ai/retrieval.ts` 以近似 Token 预算筛选最近消息和记忆：分别为 6000 和 1600。该估算不是模型 tokenizer，也不是严格的请求总 Token 上限；最新消息会保留。

- **条件式查询改写**：包含“它”“这个”“刚才”等指代词，或非常短的问句时，使用最近最多 6 条消息改写为独立检索查询；失败则使用原问题。
- **语义通道**：将检索查询 Embedding，按 pgvector 余弦距离排序。
- **词法通道**：使用 `pg_trgm` 的字符相似度，并对查询中的错误码、版本号、函数名等 ASCII 技术实体进行精确子串命中加权。这是同一条词法通道内的两个评分信号，不是 BM25。
- **融合与筛选**：RRF 按两路候选名次融合，不直接相加异构分数；随后按各通道阈值、最近消息来源去重、`memoryKey` 覆盖规则和记忆预算筛选。

Embedding 服务或任一检索通道失败时，其他通道仍可工作；两路都失败时使用最近原文继续回答。历史记忆作为引用数据注入系统提示词，不被视为新的用户指令。

## 分支可见范围

项目只支持主对话下的一层分支，不支持分支嵌套。最近消息和两路记忆检索都先以 `user_id`、当前 chat 和分支锚点限制候选：主对话只读自身；分支只读自身及父对话锚点之前的内容。锚点后的主线消息、兄弟分支和其他用户的数据不能进入候选。`migrations/0005_improve_rag_pipeline.sql` 为消息增加全局 `sequence_no`，以稳定顺序判断锚点前后。

## 数据库与部署

- `migrations/0004_add_conversation_memories.sql`：启用 pgvector，建立记忆表。
- `migrations/0005_improve_rag_pipeline.sql`：增加消息顺序、结构化记忆及失效字段，并启用 `pg_trgm` 和相关索引。
- `app/lib/ai/provider.ts`、`embedding.ts`：配置和校验 1024 维 Embedding。
- `app/lib/ai/context.ts`、`memory.ts`、`retrieval.ts`、`query-rewrite.ts`：上下文组装和检索。

服务端配置 `POSTGRES_URL`、`DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`，以及聊天所需的 `DEEPSEEK_API_KEY`。密钥只放在 `.env.local` 或部署平台服务端配置，不使用 `NEXT_PUBLIC_` 前缀。新环境先执行 `pnpm db:migrate`，再运行 `pnpm check`。数据库必须能启用 `vector` 和 `pg_trgm` 扩展。

有旧消息时可先运行 `pnpm db:backfill-memories -- --dry-run`，再运行 `pnpm db:backfill-memories`。该回填脚本会为历史完整问答建立兼容索引，但使用完整问答作为 `retrieval_text`、类型为低权重 `discussion`，**不会**像新请求一样执行结构化抽取；若需统一历史质量，应另做受控重建。回填会调用 Embedding 服务，可能产生费用。

## 验证与边界

单元测试覆盖清洗与抽取回退、预算、RRF、上下文筛选和评估指标。`/api/chat` 在非生产环境输出不含用户原文的检索 Trace，便于追踪候选 ID、分数、耗时和降级原因。离线指标及数据集规范见 [RAG_EVALUATION.md](./RAG_EVALUATION.md)；目前没有可用于宣称召回率提升的真实对照实验结果。

当前每轮最多一条记忆，没有多条原子事实拆分、文档切片、BM25、独立 Reranker、递归祖先分支或自动对话摘要。数据量增长后，应结合真实查询计划和评测结果决定是否引入 HNSW、BM25 或 Reranker，而不是预设它们一定更好。

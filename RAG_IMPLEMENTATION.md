# RAG 对话记忆实现记录

本文描述当前代码中的对话记忆入库、检索、分支隔离和运行边界。完整聊天记录以 `messages` 为准，`conversation_memories` 是可重建的检索索引；它不是 PDF 或网页知识库。

## 数据流

```text
浏览器只提交最新用户消息
  → 服务端校验用户与 chat 归属
  → 读取最近消息（最多 16 条）
  → 需要消解指代时改写检索查询
  → pgvector 语义召回 + 自维护 BM25 词法召回
  → RRF 融合、相关度过滤、去重、分支内事实覆盖
  → 注入最多 3 条较早记忆，与最近消息一起生成回答
  → 保存完整 assistant 消息
  → 仅对 completed 问答尝试提取并保存长期记忆
```

查询改写只影响检索，不替换用户原问题。普通独立问题不调用改写模型，并行读取最近消息和两路候选；需要改写的问题先读取最近消息，再并行执行两路检索。

## 入库与结构化记忆

`app/lib/ai/memory-extractor.ts` 先过滤“你好”“谢谢”“继续”等明显低价值轮次，再让模型判断一轮完整问答是否值得保存。每轮最多抽取 **一条** 自包含记忆，包含 `retrievalText`、`memoryType`、`shouldTrackChanges`、`keywords` 和 `importance`。这属于对话记忆抽取，不是对长文档做多 Chunk 切分。抽取失败时回退为低权重 `discussion` 记忆；模型判断不值得保存时则不建索引。

`app/lib/ai/memory.ts` 将完整问答保存为 `content`，供召回后作为历史参考；只对精简的 `retrievalText` 生成 `text-embedding-v4` 的 1024 维向量。插入时再次在 SQL 中验证用户、chat、消息角色和两条消息的 `completed` 状态，并以来源 assistant 消息 ID 防止重复入库。`interrupted` 回答保留为聊天记录，但不建长期记忆。记忆写入失败不会撤销已经保存的聊天消息。

需要版本管理的记忆会进入 `app/lib/ai/memory-key.ts`：先读取当前时间线可见的语义 Key 注册表；可见 Key 不超过 50 个时全部交给模型，超过时通过词项重合和向量距离召回 Top 10。模型只能复用候选中的精确 Key、创建符合小写英文点分格式的新 Key，或者返回 `null`。每个 Key 同时保存不包含当前值的 `description` 和首次注册时的例子，降低“主题相关但属性不同”造成的错误复用；例子不随父对话后续值更新，避免分支越过锚点看到未来内容。

Key 注册表遵守分支可见范围：主对话只读取自身，分支读取自身及父对话锚点之前的 Key；分支复用父 Key 时会建立分支本地的同名注册项，不回写父对话。新 Key 和复用结果最终仍以 `project.database` 这类语义字符串写入 `conversation_memories.memory_key`。同一 chat 内，新的非空 `memoryKey` 会将旧的同键记忆标记 `invalidated_at` 并记录 `superseded_by`；检索组装时，如果当前分支有同键候选，会排除继承来的父对话同键候选。

## 检索与上下文组装

`app/lib/ai/context.ts` 限制最近消息最多 16 条，每路检索最多取 20 条候选，最终最多注入 3 条记忆。`app/lib/ai/retrieval.ts` 以近似 Token 预算筛选最近消息和记忆：分别为 6000 和 1600。该估算不是模型 tokenizer，也不是严格的请求总 Token 上限；最新消息会保留。

- **条件式查询改写**：包含“它”“这个”“刚才”等指代词，或非常短的问句时，使用最近最多 6 条消息改写为独立检索查询；失败则使用原问题。
- **语义通道**：将检索查询 Embedding，按 pgvector 余弦距离排序。
- **词法通道**：使用不依赖搜索扩展的 BM25。`bm25_tokenize` 将连续中文切成双字词项，将英文、数字和代码标识符保留为完整技术词并补充子词。查询在当前用户可见的对话时间线内计算文档频率、平均文档长度和 BM25 分数，参数为 `k1 = 1.2`、`b = 0.75`。
- **融合与筛选**：RRF 按两路候选名次融合，不直接相加异构分数；随后按各通道阈值、最近消息来源去重、`memoryKey` 覆盖规则和记忆预算筛选。

Embedding 服务或任一检索通道失败时，其他通道仍可工作；两路都失败时使用最近原文继续回答。历史记忆作为引用数据注入系统提示词，不被视为新的用户指令。

## 分支可见范围

项目只支持主对话下的一层分支，不支持分支嵌套。最近消息和两路记忆检索都先以 `user_id`、当前 chat 和分支锚点限制候选：主对话只读自身；分支只读自身及父对话锚点之前的内容。锚点后的主线消息、兄弟分支和其他用户的数据不能进入候选。`migrations/0005_improve_rag_pipeline.sql` 为消息增加全局 `sequence_no`，以稳定顺序判断锚点前后。

## 数据库与部署

- `migrations/0004_add_conversation_memories.sql`：启用 pgvector，建立记忆表。
- `migrations/0005_improve_rag_pipeline.sql`：增加消息顺序、结构化记忆及失效字段（历史迁移曾启用 `pg_trgm`）。
- `migrations/0006_replace_trigram_with_bm25.sql`：增加 BM25 分词函数、生成列和 GIN 词项索引，为已有记忆自动生成检索数据，并删除 trigram 索引和 `pg_trgm` 扩展。
- `migrations/0007_add_memory_key_catalog.sql`：建立语义化 Key 注册表并登记已有 Key；注册项按用户、对话和分支锚点隔离。
- `migrations/0008_preserve_memory_key_branch_boundary.sql`：将注册表示例固定为首次可见值，防止父对话后续更新经 Key 元数据泄露给旧分支。
- `app/lib/ai/provider.ts`、`embedding.ts`：配置和校验 1024 维 Embedding。
- `app/lib/ai/context.ts`、`memory.ts`、`retrieval.ts`、`query-rewrite.ts`：上下文组装和检索。

服务端配置 `POSTGRES_URL`、`DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`，以及聊天所需的 `DEEPSEEK_API_KEY`。密钥只放在 `.env.local` 或部署平台服务端配置，不使用 `NEXT_PUBLIC_` 前缀。新环境先执行 `pnpm db:migrate`，再运行 `pnpm check`。数据库只需能启用 `vector` 扩展；BM25 本身不依赖额外扩展。

有旧消息时可先运行 `pnpm db:backfill-memories -- --dry-run`，再运行 `pnpm db:backfill-memories`。该回填脚本会为历史完整问答建立兼容索引，但使用完整问答作为 `retrieval_text`、类型为低权重 `discussion`，**不会**像新请求一样执行结构化抽取；若需统一历史质量，应另做受控重建。回填会调用 Embedding 服务，可能产生费用。

## 验证与边界

单元测试覆盖清洗与抽取回退、语义 Key 的复用/创建保护、预算、RRF、上下文筛选和评估指标。`/api/chat` 在非生产环境输出不含用户原文的检索 Trace，便于追踪候选 ID、分数、耗时和降级原因。离线指标及数据集规范见 [RAG_EVALUATION.md](./RAG_EVALUATION.md)；目前没有可用于宣称召回率提升的真实对照实验结果。

当前每轮最多一条记忆，没有多条原子事实拆分、文档切片、独立 Reranker、递归祖先分支或自动对话摘要。当前中文 BM25 使用确定性的双字切分，不等价于语言学分词；数据量增长后，应结合真实查询计划和评测结果决定是否引入 HNSW、专业中文分词或 Reranker，而不是预设它们一定更好。

import { sql } from '@/app/lib/db/client'
import { embedText } from '@/app/lib/ai/embedding'
import { EMBEDDING_MODEL_ID } from '@/app/lib/ai/provider'
import { type RetrievalChannel } from '@/app/lib/ai/retrieval'

const MAX_TEXT_CHARACTERS_PER_MESSAGE = 6_000

export type ConversationMemory = {
  id: string
  chatId: string
  content: string
  similarity: number
  denseSimilarity: number | null
  bm25Score: number | null
  retrievalScore: number
  retrievalChannels: RetrievalChannel[]
  retrievalText: string
  memoryType:
    | 'user_fact'
    | 'preference'
    | 'decision'
    | 'requirement'
    | 'discussion'
  memoryKey: string | null
  importance: number
  sourceUserMessageId: string
  sourceAssistantMessageId: string
}

type BaseMemoryRow = {
  id: string
  chat_id: string
  content: string
  retrieval_text: string
  memory_type: ConversationMemory['memoryType']
  memory_key: string | null
  importance: number
  source_user_message_id: string
  source_assistant_message_id: string
}

type DenseMemoryRow = BaseMemoryRow & {
  similarity: number
}

type Bm25MemoryRow = BaseMemoryRow & {
  bm25_score: number
}

function mapMemoryRow(
  row: BaseMemoryRow,
  scores: {
    denseSimilarity?: number | null
    bm25Score?: number | null
  },
): ConversationMemory {
  const denseSimilarity = scores.denseSimilarity ?? null
  const bm25Score = scores.bm25Score ?? null
  const similarity = Math.max(
    denseSimilarity ?? Number.NEGATIVE_INFINITY,
    bm25Score ?? Number.NEGATIVE_INFINITY,
    0,
  )

  return {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    similarity,
    denseSimilarity,
    bm25Score,
    retrievalScore: similarity,
    retrievalChannels: denseSimilarity === null ? ['bm25'] : ['dense'],
    retrievalText: row.retrieval_text,
    memoryType: row.memory_type,
    memoryKey: row.memory_key,
    importance: row.importance,
    sourceUserMessageId: row.source_user_message_id,
    sourceAssistantMessageId: row.source_assistant_message_id,
  }
}

/**
 * pgvector 接受形如 [0.1,-0.2,0.3] 的文本表示。
 * 向量本身来自可信的 Embedding API，并继续作为 SQL 参数传入，不拼接进 SQL。
 */
export function serializeVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

function clipMessageText(text: string): string {
  const normalized = text.trim()
  if (normalized.length <= MAX_TEXT_CHARACTERS_PER_MESSAGE) {
    return normalized
  }

  return `${normalized.slice(0, MAX_TEXT_CHARACTERS_PER_MESSAGE)}\n[内容已截断]`
}

/**
 * 第一版以“一问一答”为一个记忆块。保留角色标签能让模型在检索结果中
 * 分清用户事实和助手回答，同时避免把整个对话压成一个主题混杂的大向量。
 */
export function buildMemoryContent({
  userText,
  assistantText,
}: {
  userText: string
  assistantText: string
}): string {
  return [
    `用户：${clipMessageText(userText)}`,
    `助手：${clipMessageText(assistantText)}`,
  ].join('\n')
}

/**
 * 为一轮已经完整落库的对话建立向量索引。（一轮指一问一答）
 * INSERT ... SELECT 会再次校验用户、对话、角色和完成状态，防止错误关联。
 */
export async function saveConversationMemory({
  userId,
  chatId,
  userMessageId,
  assistantMessageId,
  userText,
  assistantText,
}: {
  userId: string
  chatId: string
  userMessageId: string
  assistantMessageId: string
  userText: string
  assistantText: string
}): Promise<boolean> {
  if (!userText.trim() || !assistantText.trim()) return false

  // content 保存完整的一问一答，命中后可作为原始证据注入模型；
  // retrievalText 则是经过抽取的短文本，只负责 Embedding 和 BM25 检索。
  const content = buildMemoryContent({ userText, assistantText })
  // 动态导入避免普通检索请求加载记忆抽取模型相关代码。
  const { extractConversationMemory } = await import('./memory-extractor')
  const extractedMemory = await extractConversationMemory({
    userText,
    assistantText,
  })
  if (!extractedMemory) return false

  // 向量只描述精简后的检索语义，避免长篇 assistant 回答稀释用户事实。
  const embedding = await embedText(extractedMemory.retrievalText)
  const vector = serializeVector(embedding)
  const memoryId = crypto.randomUUID()
  const keywordsJson = JSON.stringify(extractedMemory.keywords)
  let memoryKey: string | null = null

  if (extractedMemory.shouldTrackChanges) {
    try {
      // Key 解析器会先读取当前对话族的语义化 Key 注册表：少量时全部
      // 提供，数量较多时只召回 Top 10，再让模型复用、创建或放弃 Key。
      const { resolveConversationMemoryKey } = await import('./memory-key')
      memoryKey = await resolveConversationMemoryKey({
        userId,
        chatId,
        sourceAssistantMessageId: assistantMessageId,
        retrievalText: extractedMemory.retrievalText,
        memoryEmbedding: embedding,
      })
    } catch (error) {
      // Key 分类失败不能阻止长期记忆入库；此时保存为独立记忆，避免错误
      // 复用一个 Key 后把无关的当前事实标记为失效。
      console.error('解析长期记忆 memoryKey 失败，已保存为独立记忆：', error)
    }
  }

  const insertedRows = await sql<{ id: string }[]>`
    INSERT INTO conversation_memories (
      id,
      user_id,
      chat_id,
      source_user_message_id,
      source_assistant_message_id,
      content,
      retrieval_text,
      memory_type,
      memory_key,
      keywords,
      importance,
      embedding,
      embedding_model
    )
    SELECT
      ${memoryId}::uuid,
      ${userId}::uuid,
      chat.id,
      user_message.id,
      assistant_message.id,
      ${content},
      ${extractedMemory.retrievalText},
      ${extractedMemory.memoryType},
      ${memoryKey},
      ARRAY(
        SELECT jsonb_array_elements_text(${keywordsJson}::jsonb)
      ),
      ${extractedMemory.importance},
      ${vector}::vector,
      ${EMBEDDING_MODEL_ID}
    FROM chats AS chat
    -- INSERT ... SELECT 再次验证两条来源消息确实属于当前用户和当前 chat，
    -- 并且都已完整结束；不能只相信上层传入的几个 UUID。
    INNER JOIN messages AS user_message
      ON user_message.id = ${userMessageId}
      AND user_message.chat_id = chat.id
      AND user_message.role = 'user'
      AND user_message.status = 'completed'
    INNER JOIN messages AS assistant_message
      ON assistant_message.id = ${assistantMessageId}
      AND assistant_message.chat_id = chat.id
      AND assistant_message.role = 'assistant'
      AND assistant_message.status = 'completed'
    WHERE chat.id = ${chatId}
      AND chat.user_id = ${userId}
    ON CONFLICT (source_assistant_message_id) DO NOTHING
    RETURNING id
  `

  if (insertedRows.length === 1 && memoryKey) {
    // 同一 chat 内的新事实替换旧事实。分支自己的新值不会修改父对话，
    // 因而不会影响主线或其他兄弟分支的历史语义。
    await sql`
      UPDATE conversation_memories
      SET
        invalidated_at = NOW(),
        superseded_by = ${memoryId}::uuid
      WHERE user_id = ${userId}
        AND chat_id = ${chatId}
        AND memory_key = ${memoryKey}
        AND id <> ${memoryId}::uuid
        AND invalidated_at IS NULL
    `
  }

  return insertedRows.length === 1
}

/**
 * 在当前对话允许看到的时间线内检索记忆：
 * - 主对话只检索自身；
 * - 分支检索自身，以及父对话中不晚于锚点的记忆；
 * - 任何查询都必须同时命中 user_id，避免跨用户泄露。
 */
export async function searchConversationMemories({
  userId,
  chatId,
  query,
  limit = 5,
}: {
  userId: string
  chatId: string
  query: string
  limit?: number
}): Promise<ConversationMemory[]> {
  if (!query.trim()) return []

  const queryEmbedding = await embedText(query) // 获取向量（用户发送的消息）
  const queryVector = serializeVector(queryEmbedding) // 转换成 PostgreSQL pgvector 可以处理的形式
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 20)

  const rows = await sql<DenseMemoryRow[]>`
    -- current_chat 既完成资源归属校验，也提供分支父 chat 和锚点。
    WITH current_chat AS (
      SELECT id, parent_chat_id, branch_from_message_id
      FROM chats
      WHERE id = ${chatId}
        AND user_id = ${userId}
    ),
    scoped_memories AS (
      -- 先把候选集合限制在用户有权看到的时间线，再计算向量距离。
      -- 不能先全局检索后过滤，否则可能造成跨用户或跨分支候选泄漏。
      SELECT memory.*
      FROM conversation_memories AS memory
      INNER JOIN messages AS source_assistant
        ON source_assistant.id = memory.source_assistant_message_id
      CROSS JOIN current_chat
      LEFT JOIN messages AS anchor
        ON anchor.id = current_chat.branch_from_message_id
        AND anchor.chat_id = current_chat.parent_chat_id
      WHERE memory.user_id = ${userId}
        AND memory.embedding_model = ${EMBEDDING_MODEL_ID}
        AND memory.invalidated_at IS NULL
        AND (
          memory.chat_id = current_chat.id
          OR (
            current_chat.parent_chat_id IS NOT NULL
            AND anchor.id IS NOT NULL
            AND memory.chat_id = current_chat.parent_chat_id
            AND (
              source_assistant.sequence_no <= anchor.sequence_no
            )
          )
        )
    )
    SELECT
      id,
      chat_id,
      content,
      retrieval_text,
      memory_type,
      memory_key,
      importance,
      source_user_message_id,
      source_assistant_message_id,
      (1 - (embedding <=> ${queryVector}::vector))::float8 AS similarity
    FROM scoped_memories
    ORDER BY embedding <=> ${queryVector}::vector
    LIMIT ${safeLimit}
  `
// <=> 是 pgvector 的余弦距离运算符。代码把距离转换成相似度

  return rows.map((row) =>
    mapMemoryRow(row, { denseSimilarity: row.similarity }),
  )
}

/**
 * BM25 通道补足向量检索对错误码、版本号、函数名和专有名词不稳定的问题。
 * 词项由数据库的 bm25_tokenize 统一生成；IDF、平均文档长度只基于当前用户
 * 在当前主对话/分支时间线内可见的记忆计算，不让其他用户的数据影响排序。
 */
export async function searchConversationMemoriesByBm25({
  userId,
  chatId,
  query,
  limit = 20,
}: {
  userId: string
  chatId: string
  query: string
  limit?: number
}): Promise<ConversationMemory[]> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return []

  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50)
  const rows = await sql<Bm25MemoryRow[]>`
    WITH query_terms AS (
      SELECT DISTINCT term
      FROM unnest(bm25_tokenize(${normalizedQuery})) AS term
    ),
    current_chat AS (
      SELECT id, parent_chat_id, branch_from_message_id
      FROM chats
      WHERE id = ${chatId}
        AND user_id = ${userId}
    ),
    scoped_memories AS NOT MATERIALIZED (
      SELECT memory.*
      FROM conversation_memories AS memory
      INNER JOIN messages AS source_assistant
        ON source_assistant.id = memory.source_assistant_message_id
      CROSS JOIN current_chat
      LEFT JOIN messages AS anchor
        ON anchor.id = current_chat.branch_from_message_id
        AND anchor.chat_id = current_chat.parent_chat_id
      WHERE memory.user_id = ${userId}
        AND memory.invalidated_at IS NULL
        AND (
          memory.chat_id = current_chat.id
          OR (
            current_chat.parent_chat_id IS NOT NULL
            AND anchor.id IS NOT NULL
            AND memory.chat_id = current_chat.parent_chat_id
            AND source_assistant.sequence_no <= anchor.sequence_no
          )
        )
    ),
    corpus_stats AS (
      SELECT
        COUNT(*)::float8 AS document_count,
        GREATEST(COALESCE(AVG(bm25_document_length), 1), 1)::float8
          AS average_document_length
      FROM scoped_memories
    ),
    document_frequencies AS (
      SELECT
        query_term.term,
        COUNT(memory.id)::float8 AS document_frequency
      FROM query_terms AS query_term
      LEFT JOIN scoped_memories AS memory
        ON memory.bm25_terms @> ARRAY[query_term.term]
      GROUP BY query_term.term
    ),
    candidates AS (
      SELECT memory.*
      FROM scoped_memories AS memory
      WHERE memory.bm25_terms && ARRAY(
        SELECT term
        FROM query_terms
      )
    )
    SELECT
      candidate.id,
      candidate.chat_id,
      candidate.content,
      candidate.retrieval_text,
      candidate.memory_type,
      candidate.memory_key,
      candidate.importance,
      candidate.source_user_message_id,
      candidate.source_assistant_message_id,
      score.bm25_score::float8
    FROM candidates AS candidate
    CROSS JOIN corpus_stats
    CROSS JOIN LATERAL (
      SELECT SUM(
        -- Robertson/Sparck Jones IDF（带正值平滑）乘以 BM25 饱和词频。
        ln(
          1 + (
            corpus_stats.document_count
              - document_frequency.document_frequency
              + 0.5
          ) / (document_frequency.document_frequency + 0.5)
        ) * (
          term_frequency.frequency * (1.2 + 1)
        ) / (
          term_frequency.frequency
            + 1.2 * (
              1 - 0.75
              + 0.75 * candidate.bm25_document_length
                / corpus_stats.average_document_length
            )
        )
      ) AS bm25_score
      FROM (
        SELECT
          document_term.term,
          COUNT(*)::float8 AS frequency
        FROM unnest(candidate.bm25_terms) AS document_term(term)
        INNER JOIN query_terms
          ON query_terms.term = document_term.term
        GROUP BY document_term.term
      ) AS term_frequency
      INNER JOIN document_frequencies AS document_frequency
        ON document_frequency.term = term_frequency.term
    ) AS score
    WHERE score.bm25_score > 0
    ORDER BY
      score.bm25_score DESC,
      candidate.importance DESC,
      candidate.id ASC
    LIMIT ${safeLimit}
  `

  return rows.map((row) =>
    mapMemoryRow(row, { bm25Score: row.bm25_score }),
  )
}

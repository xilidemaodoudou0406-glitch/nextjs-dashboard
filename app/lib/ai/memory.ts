import { sql } from '@/app/lib/db/client'
import { embedText } from '@/app/lib/ai/embedding'
import {
  EMBEDDING_MODEL_ID,
} from '@/app/lib/ai/provider'

const MAX_TEXT_CHARACTERS_PER_MESSAGE = 6_000

export type ConversationMemory = {
  id: string
  content: string
  similarity: number
  sourceUserMessageId: string
  sourceAssistantMessageId: string
}

type MemoryRow = {
  id: string
  content: string
  similarity: number
  source_user_message_id: string
  source_assistant_message_id: string
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

  const content = buildMemoryContent({ userText, assistantText })
  const embedding = await embedText(content)
  const vector = serializeVector(embedding)

  const insertedRows = await sql<{ id: string }[]>`
    INSERT INTO conversation_memories (
      user_id,
      chat_id,
      source_user_message_id,
      source_assistant_message_id,
      content,
      embedding,
      embedding_model
    )
    SELECT
      ${userId}::uuid,
      chat.id,
      user_message.id,
      assistant_message.id,
      ${content},
      ${vector}::vector,
      ${EMBEDDING_MODEL_ID}
    FROM chats AS chat
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

  const rows = await sql<MemoryRow[]>`
    WITH current_chat AS (
      SELECT id, parent_chat_id, branch_from_message_id
      FROM chats
      WHERE id = ${chatId}
        AND user_id = ${userId}
    ),
    scoped_memories AS (
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
        AND (
          memory.chat_id = current_chat.id
          OR (
            current_chat.parent_chat_id IS NOT NULL
            AND anchor.id IS NOT NULL
            AND memory.chat_id = current_chat.parent_chat_id
            AND (
              source_assistant.created_at < anchor.created_at
              OR (
                source_assistant.created_at = anchor.created_at
                AND source_assistant.id <= anchor.id
              )
            )
          )
        )
    )
    SELECT
      id,
      content,
      source_user_message_id,
      source_assistant_message_id,
      (1 - (embedding <=> ${queryVector}::vector))::float8 AS similarity
    FROM scoped_memories
    ORDER BY embedding <=> ${queryVector}::vector
    LIMIT ${safeLimit}
  `
// <=> 是 pgvector 的余弦距离运算符。代码把距离转换成相似度

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    similarity: row.similarity,
    sourceUserMessageId: row.source_user_message_id,
    sourceAssistantMessageId: row.source_assistant_message_id,
  }))
}


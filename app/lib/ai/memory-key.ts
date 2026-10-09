import { generateText, Output } from 'ai'
import { z } from 'zod'

import { embedText } from '@/app/lib/ai/embedding'
import { EMBEDDING_MODEL_ID, models } from '@/app/lib/ai/provider'
import { sql } from '@/app/lib/db/client'

export const MEMORY_KEY_FULL_SCAN_LIMIT = 50
export const MEMORY_KEY_CANDIDATE_LIMIT = 10

const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/

export type MemoryKeyCandidate = {
  memory_key: string
  description: string
  examples: string[]
  has_embedding: boolean
  is_local: boolean
}

const memoryKeyDecisionSchema = z.object({
  action: z.enum(['reuse', 'create', 'none']),
  existingKey: z.string().max(200).nullable(),
  newKey: z
    .string()
    .max(200)
    .regex(MEMORY_KEY_PATTERN)
    .nullable(),
  description: z.string().max(500).nullable(),
})

function serializeVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export function normalizeSemanticMemoryKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * 读取当前对话真正可见的 Key：主对话只看自身；分支看自身以及父对话锚点
 * 之前创建的 Key。同名时优先使用分支自己的注册记录。
 */
async function listVisibleMemoryKeys({
  userId,
  chatId,
  limit,
}: {
  userId: string
  chatId: string
  limit: number
}): Promise<MemoryKeyCandidate[]> {
  return sql<MemoryKeyCandidate[]>`
    WITH current_chat AS (
      SELECT id, parent_chat_id, branch_from_message_id
      FROM chats
      WHERE id = ${chatId}
        AND user_id = ${userId}
    ),
    visible_keys AS (
      SELECT
        key.memory_key,
        key.description,
        key.examples,
        (key.embedding IS NOT NULL) AS has_embedding,
        (key.chat_id = current_chat.id) AS is_local,
        key.updated_at
      FROM conversation_memory_keys AS key
      INNER JOIN messages AS source_assistant
        ON source_assistant.id = key.source_assistant_message_id
        AND source_assistant.chat_id = key.chat_id
      CROSS JOIN current_chat
      LEFT JOIN messages AS anchor
        ON anchor.id = current_chat.branch_from_message_id
        AND anchor.chat_id = current_chat.parent_chat_id
      WHERE key.user_id = ${userId}
        AND (
          key.chat_id = current_chat.id
          OR (
            current_chat.parent_chat_id IS NOT NULL
            AND anchor.id IS NOT NULL
            AND key.chat_id = current_chat.parent_chat_id
            AND source_assistant.sequence_no <= anchor.sequence_no
          )
        )
    )
    SELECT DISTINCT ON (memory_key)
      memory_key,
      description,
      examples,
      has_embedding,
      is_local
    FROM visible_keys
    ORDER BY memory_key, is_local DESC, updated_at DESC
    LIMIT ${limit}
  `
}

/**
 * Key 较少时完整提供；超过阈值后同时考虑词项重合与向量距离，只把 Top 10
 * 交给模型。词项排序还能照顾迁移进注册表、暂时没有 embedding 的旧 Key。
 */
export async function findMemoryKeyCandidates({
  userId,
  chatId,
  retrievalText,
  memoryEmbedding,
}: {
  userId: string
  chatId: string
  retrievalText: string
  memoryEmbedding: number[]
}): Promise<MemoryKeyCandidate[]> {
  const allWhenSmall = await listVisibleMemoryKeys({
    userId,
    chatId,
    limit: MEMORY_KEY_FULL_SCAN_LIMIT + 1,
  })
  if (allWhenSmall.length <= MEMORY_KEY_FULL_SCAN_LIMIT) {
    return allWhenSmall
  }

  const vector = serializeVector(memoryEmbedding)
  return sql<MemoryKeyCandidate[]>`
    WITH current_chat AS (
      SELECT id, parent_chat_id, branch_from_message_id
      FROM chats
      WHERE id = ${chatId}
        AND user_id = ${userId}
    ),
    query_terms AS (
      SELECT DISTINCT term
      FROM unnest(bm25_tokenize(${retrievalText})) AS term
    ),
    visible_keys AS (
      SELECT
        key.*,
        (key.chat_id = current_chat.id) AS is_local
      FROM conversation_memory_keys AS key
      INNER JOIN messages AS source_assistant
        ON source_assistant.id = key.source_assistant_message_id
        AND source_assistant.chat_id = key.chat_id
      CROSS JOIN current_chat
      LEFT JOIN messages AS anchor
        ON anchor.id = current_chat.branch_from_message_id
        AND anchor.chat_id = current_chat.parent_chat_id
      WHERE key.user_id = ${userId}
        AND (
          key.chat_id = current_chat.id
          OR (
            current_chat.parent_chat_id IS NOT NULL
            AND anchor.id IS NOT NULL
            AND key.chat_id = current_chat.parent_chat_id
            AND source_assistant.sequence_no <= anchor.sequence_no
          )
        )
    ),
    deduplicated_keys AS (
      SELECT DISTINCT ON (memory_key)
        memory_key,
        description,
        examples,
        embedding,
        embedding_model,
        is_local,
        updated_at
      FROM visible_keys
      ORDER BY memory_key, is_local DESC, updated_at DESC
    ),
    scored_keys AS (
      SELECT
        key.*,
        (
          SELECT COUNT(DISTINCT query_term.term)::int
          FROM query_terms AS query_term
          WHERE query_term.term = ANY(
            bm25_tokenize(
              key.memory_key || ' ' || key.description || ' '
                || array_to_string(key.examples, ' ')
            )
          )
        ) AS lexical_matches
      FROM deduplicated_keys AS key
    )
    SELECT
      memory_key,
      description,
      examples,
      (embedding IS NOT NULL) AS has_embedding,
      is_local
    FROM scored_keys
    ORDER BY
      lexical_matches DESC,
      CASE
        WHEN embedding IS NOT NULL
          AND embedding_model = ${EMBEDDING_MODEL_ID}
        THEN 0
        ELSE 1
      END ASC,
      CASE
        WHEN embedding IS NOT NULL
          AND embedding_model = ${EMBEDDING_MODEL_ID}
        THEN embedding <=> ${vector}::vector
        ELSE NULL
      END ASC NULLS LAST,
      updated_at DESC,
      memory_key ASC
    LIMIT ${MEMORY_KEY_CANDIDATE_LIMIT}
  `
}

async function registerMemoryKey({
  userId,
  chatId,
  sourceAssistantMessageId,
  memoryKey,
  description,
  example,
  embedding,
}: {
  userId: string
  chatId: string
  sourceAssistantMessageId: string
  memoryKey: string
  description: string
  example: string
  embedding: number[] | null
}): Promise<string | null> {
  const vector = embedding ? serializeVector(embedding) : null
  const embeddingModel = embedding ? EMBEDDING_MODEL_ID : null
  const [registeredKey] = await sql<{ memory_key: string }[]>`
    INSERT INTO conversation_memory_keys (
      user_id,
      chat_id,
      source_assistant_message_id,
      memory_key,
      description,
      examples,
      embedding,
      embedding_model
    )
    SELECT
      ${userId}::uuid,
      chat.id,
      source_assistant.id,
      ${memoryKey},
      ${description},
      ARRAY[${example}]::TEXT[],
      ${vector}::vector,
      ${embeddingModel}
    FROM chats AS chat
    INNER JOIN messages AS source_assistant
      ON source_assistant.id = ${sourceAssistantMessageId}
      AND source_assistant.chat_id = chat.id
      AND source_assistant.role = 'assistant'
      AND source_assistant.status = 'completed'
    WHERE chat.id = ${chatId}
      AND chat.user_id = ${userId}
    ON CONFLICT (user_id, chat_id, memory_key)
    DO UPDATE SET
      embedding = COALESCE(
        conversation_memory_keys.embedding,
        EXCLUDED.embedding
      ),
      embedding_model = COALESCE(
        conversation_memory_keys.embedding_model,
        EXCLUDED.embedding_model
      ),
      updated_at = NOW()
    RETURNING memory_key
  `

  return registeredKey?.memory_key ?? null
}

/**
 * 为需要版本管理的记忆解析语义化 Key。模型只能复用候选列表中的精确 Key、
 * 创建一个符合命名规则的新 Key，或者判定该记忆不应使用 Key。
 */
export async function resolveConversationMemoryKey({
  userId,
  chatId,
  sourceAssistantMessageId,
  retrievalText,
  memoryEmbedding,
}: {
  userId: string
  chatId: string
  sourceAssistantMessageId: string
  retrievalText: string
  memoryEmbedding: number[]
}): Promise<string | null> {
  // 这里去读memorykey注册表
  const candidates = await findMemoryKeyCandidates({
    userId,
    chatId,
    retrievalText,
    memoryEmbedding,
  })
  const candidatesByKey = new Map(
    candidates.map((candidate) => [candidate.memory_key, candidate]),
  )

  const result = await generateText({
    model: models['deepseek-chat'],
    output: Output.object({ schema: memoryKeyDecisionSchema }),
    system: [
      '你负责为长期记忆选择语义化 memoryKey，不负责回答用户问题。',
      'memoryKey 表示一个可被新值替换的事实位置，例如 project.database，而不是当前值。',
      '只有新记忆在替换同一主体、同一属性的旧事实时，才复用已有 Key。',
      '主题相关但可以同时成立的事实不是同一属性，必须创建新 Key；例如数据库类型和数据库备份时间不能共用 Key。',
      '若候选中存在完全相同的事实位置，action=reuse 且 existingKey 必须逐字复制候选 Key。',
      '若没有合适候选但这是可变事实，action=create，并生成小写英文点分 Key 与不包含当前值的中文 description。',
      '若只是普通讨论或不需要版本覆盖，action=none。无法确定是否同一属性时不要强行复用。',
      '无论选择哪种 action，都必须返回 existingKey、newKey、description；不适用字段填写 null。',
    ].join('\n'),
    prompt: JSON.stringify({
      memory: retrievalText,
      candidates: candidates.map((candidate) => ({
        key: candidate.memory_key,
        description: candidate.description,
        examples: candidate.examples,
      })),
    }),
    maxOutputTokens: 240,
  })

  if (!result.output || result.output.action === 'none') return null

  if (result.output.action === 'reuse') {
    const existingKey = result.output.existingKey?.trim() ?? ''
    const candidate = candidatesByKey.get(existingKey)
    if (!candidate) return null

    // 分支复用父对话的 Key 时在分支本地注册同名 Key，不能回写父目录，
    // 否则父对话会通过 examples 间接看到分支内容。
    const keyEmbedding =
      candidate.is_local && candidate.has_embedding
        ? null
        : await embedText(`${existingKey}\n${candidate.description}`)
    return registerMemoryKey({
      userId,
      chatId,
      sourceAssistantMessageId,
      memoryKey: existingKey,
      description: candidate.description,
      example: retrievalText,
      embedding: keyEmbedding,
    })
  }

  const newKey = normalizeSemanticMemoryKey(result.output.newKey ?? '')
  const description = result.output.description?.trim() ?? ''
  if (!MEMORY_KEY_PATTERN.test(newKey) || !description) return null

  const keyEmbedding = await embedText(`${newKey}\n${description}`)
  return registerMemoryKey({
    userId,
    chatId,
    sourceAssistantMessageId,
    memoryKey: newKey,
    description,
    example: retrievalText,
    embedding: keyEmbedding,
  })
}

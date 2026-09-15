import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { embedMany } from 'ai'
import postgres from 'postgres'

const projectRoot = resolve(import.meta.dirname, '..')
const envFile = ['.env.local', '.env']
  .map((file) => resolve(projectRoot, file))
  .find(existsSync)

// Node.js 24 原生加载本地环境变量。部署平台或命令行已经提供的变量优先。
if (envFile) process.loadEnvFile(envFile)

const databaseUrl = process.env.POSTGRES_URL
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY
const dashscopeBaseUrl = process.env.DASHSCOPE_BASE_URL

if (!databaseUrl || !dashscopeApiKey || !dashscopeBaseUrl) {
  throw new Error(
    '缺少 POSTGRES_URL、DASHSCOPE_API_KEY 或 DASHSCOPE_BASE_URL，请先配置 .env.local。',
  )
}

const EMBEDDING_MODEL_ID = 'text-embedding-v4'
const EMBEDDING_DIMENSIONS = 1024
const BATCH_SIZE = 10
const MAX_TEXT_CHARACTERS_PER_MESSAGE = 6_000

const hostname = new URL(databaseUrl).hostname
const isLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(
  hostname,
)
const sql = postgres(databaseUrl, {
  ssl: isLocalDatabase ? false : 'require',
  max: 1,
})
const dashscope = createOpenAICompatible({
  name: 'dashscope',
  baseURL: dashscopeBaseUrl,
  apiKey: dashscopeApiKey,
})
const embeddingModel = dashscope.embeddingModel(EMBEDDING_MODEL_ID)

function clipText(text) {
  const normalized = text.trim()
  if (normalized.length <= MAX_TEXT_CHARACTERS_PER_MESSAGE) {
    return normalized
  }

  return `${normalized.slice(0, MAX_TEXT_CHARACTERS_PER_MESSAGE)}\n[内容已截断]`
}

function buildMemoryContent(userText, assistantText) {
  return `用户：${clipText(userText)}\n助手：${clipText(assistantText)}`
}

function serializeVector(embedding) {
  return `[${embedding.join(',')}]`
}

try {
  // 只回填时间线上相邻且完整的一问一答；已有记忆通过 LEFT JOIN 跳过。
  const rows = await sql`
    WITH ordered_messages AS (
      SELECT
        message.id,
        message.chat_id,
        message.role,
        message.content,
        message.status,
        message.created_at,
        LEAD(message.id) OVER (
          PARTITION BY message.chat_id
          ORDER BY message.created_at ASC, message.id ASC
        ) AS next_message_id
      FROM messages AS message
    )
    SELECT
      chat.user_id,
      user_message.chat_id,
      user_message.id AS user_message_id,
      user_message.content AS user_content,
      assistant_message.id AS assistant_message_id,
      assistant_message.content AS assistant_content
    FROM ordered_messages AS user_message
    INNER JOIN messages AS assistant_message
      ON assistant_message.id = user_message.next_message_id
      AND assistant_message.chat_id = user_message.chat_id
    INNER JOIN chats AS chat
      ON chat.id = user_message.chat_id
    LEFT JOIN conversation_memories AS existing_memory
      ON existing_memory.source_assistant_message_id = assistant_message.id
    WHERE user_message.role = 'user'
      AND user_message.status = 'completed'
      AND assistant_message.role = 'assistant'
      AND assistant_message.status = 'completed'
      AND length(btrim(user_message.content)) > 0
      AND length(btrim(assistant_message.content)) > 0
      AND existing_memory.id IS NULL
    ORDER BY user_message.created_at ASC, user_message.id ASC
  `

  if (process.argv.includes('--dry-run')) {
    // 只统计数量，不向 Embedding 服务发送文本，也不写数据库。
    console.log(`待回填历史记忆数量：${rows.length}`)
  } else {
    let insertedCount = 0

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE)
      const contents = batch.map((row) =>
        buildMemoryContent(row.user_content, row.assistant_content),
      )
      const { embeddings } = await embedMany({
        model: embeddingModel,
        values: contents,
        providerOptions: {
          dashscope: {
            dimensions: EMBEDDING_DIMENSIONS,
          },
        },
      })

      if (
        embeddings.length !== batch.length ||
        embeddings.some(
          (embedding) => embedding.length !== EMBEDDING_DIMENSIONS,
        )
      ) {
        throw new Error('Embedding 返回数量或维度与请求不一致')
      }

      await sql.begin(async (transaction) => {
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index]
          const inserted = await transaction`
            INSERT INTO conversation_memories (
              user_id,
              chat_id,
              source_user_message_id,
              source_assistant_message_id,
              content,
              embedding,
              embedding_model
            )
            VALUES (
              ${row.user_id}::uuid,
              ${row.chat_id}::uuid,
              ${row.user_message_id}::uuid,
              ${row.assistant_message_id}::uuid,
              ${contents[index]},
              ${serializeVector(embeddings[index])}::vector,
              ${EMBEDDING_MODEL_ID}
            )
            ON CONFLICT (source_assistant_message_id) DO NOTHING
            RETURNING id
          `
          insertedCount += inserted.length
        }
      })

      console.log(
        `已处理 ${Math.min(offset + batch.length, rows.length)}/${rows.length} 条历史记忆`,
      )
    }

    console.log(`历史记忆回填完成，新增 ${insertedCount} 条`)
  }
} finally {
  await sql.end()
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  embedText: vi.fn(),
  extractConversationMemory: vi.fn(),
  sql: vi.fn(),
}))

vi.mock('@/app/lib/ai/embedding', () => ({
  embedText: mocks.embedText,
}))

vi.mock('@/app/lib/ai/provider', () => ({
  EMBEDDING_MODEL_ID: 'text-embedding-v4',
}))

vi.mock('@/app/lib/ai/memory-extractor', () => ({
  extractConversationMemory: mocks.extractConversationMemory,
}))

vi.mock('@/app/lib/db/client', () => ({
  sql: mocks.sql,
}))

import {
  buildMemoryContent,
  saveConversationMemory,
  searchConversationMemories,
  searchConversationMemoriesByKeyword,
  serializeVector,
} from './memory'

describe('conversation memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.extractConversationMemory.mockResolvedValue({
      retrievalText: '项目数据库使用 PostgreSQL',
      memoryType: 'decision',
      memoryKey: 'project.database',
      keywords: ['postgresql'],
      importance: 0.9,
    })
  })

  it('serializes a vector in pgvector text format', () => {
    expect(serializeVector([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]')
  })

  it('builds a self-contained user and assistant memory', () => {
    expect(
      buildMemoryContent({
        userText: '  我使用 PostgreSQL  ',
        assistantText: '  可以配合 pgvector。  ',
      }),
    ).toBe('用户：我使用 PostgreSQL\n助手：可以配合 pgvector。')
  })

  it('skips image-only or empty-text turns', async () => {
    await expect(
      saveConversationMemory({
        userId: 'user-id',
        chatId: 'chat-id',
        userMessageId: 'user-message-id',
        assistantMessageId: 'assistant-message-id',
        userText: '   ',
        assistantText: '图片说明',
      }),
    ).resolves.toBe(false)
    expect(mocks.embedText).not.toHaveBeenCalled()
    expect(mocks.sql).not.toHaveBeenCalled()
  })

  it('embeds and persists a completed turn', async () => {
    mocks.embedText.mockResolvedValue([0.1, 0.2])
    mocks.sql.mockResolvedValue([{ id: 'memory-id' }])

    await expect(
      saveConversationMemory({
        userId: 'user-id',
        chatId: 'chat-id',
        userMessageId: 'user-message-id',
        assistantMessageId: 'assistant-message-id',
        userText: '数据库是什么？',
        assistantText: 'PostgreSQL',
      }),
    ).resolves.toBe(true)

    expect(mocks.embedText).toHaveBeenCalledWith(
      '项目数据库使用 PostgreSQL',
    )
    expect(mocks.sql).toHaveBeenCalledTimes(2)
  })

  it('maps scoped vector search rows to application fields', async () => {
    mocks.embedText.mockResolvedValue([0.1, 0.2])
    mocks.sql.mockResolvedValue([
      {
        id: 'memory-id',
        chat_id: 'chat-id',
        content: '相关记忆',
        retrieval_text: '相关记忆的检索文本',
        memory_type: 'discussion',
        memory_key: null,
        importance: 0.5,
        similarity: 0.82,
        source_user_message_id: 'user-message-id',
        source_assistant_message_id: 'assistant-message-id',
      },
    ])

    await expect(
      searchConversationMemories({
        userId: 'user-id',
        chatId: 'chat-id',
        query: '之前的数据库',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'memory-id',
        chatId: 'chat-id',
        content: '相关记忆',
        similarity: 0.82,
        denseSimilarity: 0.82,
        keywordSimilarity: null,
        retrievalChannels: ['dense'],
        sourceUserMessageId: 'user-message-id',
        sourceAssistantMessageId: 'assistant-message-id',
      }),
    ])
  })

  it('maps keyword search rows without calling the embedding service', async () => {
    mocks.sql.mockResolvedValue([
      {
        id: 'keyword-memory',
        chat_id: 'chat-id',
        content: '错误码 23505 表示唯一约束冲突',
        retrieval_text: 'PostgreSQL 错误码 23505 唯一约束冲突',
        memory_type: 'discussion',
        memory_key: null,
        importance: 0.7,
        keyword_similarity: 0.91,
        source_user_message_id: 'user-message-id',
        source_assistant_message_id: 'assistant-message-id',
      },
    ])

    const result = await searchConversationMemoriesByKeyword({
      userId: 'user-id',
      chatId: 'chat-id',
      query: '23505 是什么错误？',
    })

    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'keyword-memory',
        denseSimilarity: null,
        keywordSimilarity: 0.91,
        retrievalChannels: ['keyword'],
      }),
    )
    expect(mocks.embedText).not.toHaveBeenCalled()
  })
})

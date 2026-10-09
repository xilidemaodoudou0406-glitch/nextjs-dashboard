import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  embedText: vi.fn(),
  extractConversationMemory: vi.fn(),
  resolveConversationMemoryKey: vi.fn(),
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

vi.mock('@/app/lib/ai/memory-key', () => ({
  resolveConversationMemoryKey: mocks.resolveConversationMemoryKey,
}))

vi.mock('@/app/lib/db/client', () => ({
  sql: mocks.sql,
}))

import {
  buildMemoryContent,
  saveConversationMemory,
  searchConversationMemories,
  searchConversationMemoriesByBm25,
  serializeVector,
} from './memory'

describe('conversation memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.extractConversationMemory.mockResolvedValue({
      retrievalText: '项目数据库使用 PostgreSQL',
      memoryType: 'decision',
      shouldTrackChanges: true,
      keywords: ['postgresql'],
      importance: 0.9,
    })
    mocks.resolveConversationMemoryKey.mockResolvedValue('project.database')
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
    expect(mocks.resolveConversationMemoryKey).toHaveBeenCalledWith({
      userId: 'user-id',
      chatId: 'chat-id',
      sourceAssistantMessageId: 'assistant-message-id',
      retrievalText: '项目数据库使用 PostgreSQL',
      memoryEmbedding: [0.1, 0.2],
    })
    expect(mocks.sql).toHaveBeenCalledTimes(2)
  })

  it('stores an independent memory without consulting the key registry', async () => {
    mocks.extractConversationMemory.mockResolvedValue({
      retrievalText: '讨论了 BM25 的计算过程',
      memoryType: 'discussion',
      shouldTrackChanges: false,
      keywords: ['bm25'],
      importance: 0.5,
    })
    mocks.embedText.mockResolvedValue([0.1, 0.2])
    mocks.sql.mockResolvedValue([{ id: 'memory-id' }])

    await expect(
      saveConversationMemory({
        userId: 'user-id',
        chatId: 'chat-id',
        userMessageId: 'user-message-id',
        assistantMessageId: 'assistant-message-id',
        userText: 'BM25 是怎么计算的？',
        assistantText: '它会结合词频和文档频率。',
      }),
    ).resolves.toBe(true)

    expect(mocks.resolveConversationMemoryKey).not.toHaveBeenCalled()
    expect(mocks.sql).toHaveBeenCalledTimes(1)
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
        bm25Score: null,
        retrievalChannels: ['dense'],
        sourceUserMessageId: 'user-message-id',
        sourceAssistantMessageId: 'assistant-message-id',
      }),
    ])
  })

  it('maps BM25 search rows without calling the embedding service', async () => {
    mocks.sql.mockResolvedValue([
      {
        id: 'bm25-memory',
        chat_id: 'chat-id',
        content: '错误码 23505 表示唯一约束冲突',
        retrieval_text: 'PostgreSQL 错误码 23505 唯一约束冲突',
        memory_type: 'discussion',
        memory_key: null,
        importance: 0.7,
        bm25_score: 4.21,
        source_user_message_id: 'user-message-id',
        source_assistant_message_id: 'assistant-message-id',
      },
    ])

    const result = await searchConversationMemoriesByBm25({
      userId: 'user-id',
      chatId: 'chat-id',
      query: '23505 是什么错误？',
    })

    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'bm25-memory',
        denseSimilarity: null,
        bm25Score: 4.21,
        retrievalChannels: ['bm25'],
      }),
    )
    expect(mocks.embedText).not.toHaveBeenCalled()
  })
})

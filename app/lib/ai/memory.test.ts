import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  embedText: vi.fn(),
  sql: vi.fn(),
}))

vi.mock('@/app/lib/ai/embedding', () => ({
  embedText: mocks.embedText,
}))

vi.mock('@/app/lib/ai/provider', () => ({
  EMBEDDING_MODEL_ID: 'text-embedding-v4',
}))

vi.mock('@/app/lib/db/client', () => ({
  sql: mocks.sql,
}))

import {
  buildMemoryContent,
  saveConversationMemory,
  searchConversationMemories,
  serializeVector,
} from './memory'

describe('conversation memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      '用户：数据库是什么？\n助手：PostgreSQL',
    )
    expect(mocks.sql).toHaveBeenCalledTimes(1)
  })

  it('maps scoped vector search rows to application fields', async () => {
    mocks.embedText.mockResolvedValue([0.1, 0.2])
    mocks.sql.mockResolvedValue([
      {
        id: 'memory-id',
        content: '相关记忆',
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
      {
        id: 'memory-id',
        content: '相关记忆',
        similarity: 0.82,
        sourceUserMessageId: 'user-message-id',
        sourceAssistantMessageId: 'assistant-message-id',
      },
    ])
  })
})


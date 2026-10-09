import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  embedText: vi.fn(),
  generateText: vi.fn(),
  sql: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn() },
}))

vi.mock('@/app/lib/ai/embedding', () => ({
  embedText: mocks.embedText,
}))

vi.mock('@/app/lib/ai/provider', () => ({
  EMBEDDING_MODEL_ID: 'text-embedding-v4',
  models: { 'deepseek-chat': {} },
}))

vi.mock('@/app/lib/db/client', () => ({
  sql: mocks.sql,
}))

import {
  findMemoryKeyCandidates,
  normalizeSemanticMemoryKey,
  resolveConversationMemoryKey,
} from './memory-key'

const candidate = {
  memory_key: 'project.database',
  description: '项目当前使用的主要数据库类型',
  examples: ['项目使用 MySQL'],
  has_embedding: true,
  is_local: true,
}

describe('semantic memory key registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes a semantic key without changing its meaning', () => {
    expect(normalizeSemanticMemoryKey(' Project.Database ')).toBe(
      'project.database',
    )
  })

  it('reuses only a key that was present in the candidate list', async () => {
    mocks.sql
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([{ memory_key: 'project.database' }])
    mocks.generateText.mockResolvedValue({
      output: {
        action: 'reuse',
        existingKey: 'project.database',
        newKey: null,
        description: null,
      },
    })

    await expect(
      resolveConversationMemoryKey({
        userId: 'user-id',
        chatId: 'chat-id',
        sourceAssistantMessageId: 'assistant-id',
        retrievalText: '项目数据库改成 PostgreSQL',
        memoryEmbedding: [0.1, 0.2],
      }),
    ).resolves.toBe('project.database')

    expect(mocks.embedText).not.toHaveBeenCalled()
    expect(mocks.sql).toHaveBeenCalledTimes(2)
  })

  it('rejects a fabricated reuse key that was not offered to the model', async () => {
    mocks.sql.mockResolvedValueOnce([candidate])
    mocks.generateText.mockResolvedValue({
      output: {
        action: 'reuse',
        existingKey: 'project.database_backup',
        newKey: null,
        description: null,
      },
    })

    await expect(
      resolveConversationMemoryKey({
        userId: 'user-id',
        chatId: 'chat-id',
        sourceAssistantMessageId: 'assistant-id',
        retrievalText: '数据库每天凌晨备份',
        memoryEmbedding: [0.1, 0.2],
      }),
    ).resolves.toBeNull()

    expect(mocks.sql).toHaveBeenCalledTimes(1)
  })

  it('registers a newly generated semantic key and its description', async () => {
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ memory_key: 'project.cache' }])
    mocks.generateText.mockResolvedValue({
      output: {
        action: 'create',
        existingKey: null,
        newKey: 'project.cache',
        description: '项目当前使用的缓存方案',
      },
    })
    mocks.embedText.mockResolvedValue([0.3, 0.4])

    await expect(
      resolveConversationMemoryKey({
        userId: 'user-id',
        chatId: 'chat-id',
        sourceAssistantMessageId: 'assistant-id',
        retrievalText: '项目使用 Redis 缓存',
        memoryEmbedding: [0.1, 0.2],
      }),
    ).resolves.toBe('project.cache')

    expect(mocks.embedText).toHaveBeenCalledWith(
      'project.cache\n项目当前使用的缓存方案',
    )
  })

  it('switches to Top 10 retrieval when more than 50 keys are visible', async () => {
    const manyKeys = Array.from({ length: 51 }, (_, index) => ({
      ...candidate,
      memory_key: `project.setting_${index}`,
    }))
    mocks.sql
      .mockResolvedValueOnce(manyKeys)
      .mockResolvedValueOnce([candidate])

    await expect(
      findMemoryKeyCandidates({
        userId: 'user-id',
        chatId: 'chat-id',
        retrievalText: '项目数据库改成 PostgreSQL',
        memoryEmbedding: [0.1, 0.2],
      }),
    ).resolves.toEqual([candidate])

    expect(mocks.sql).toHaveBeenCalledTimes(2)
  })
})

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn() },
}))

vi.mock('./provider', () => ({
  models: { 'deepseek-chat': {} },
}))

import {
  extractConversationMemory,
  isLowValueMemoryTurn,
} from './memory-extractor'

describe('memory extraction guard', () => {
  it('filters greetings and no-information follow-ups', () => {
    expect(
      isLowValueMemoryTurn({ userText: '你好', assistantText: '你好！' }),
    ).toBe(true)
    expect(
      isLowValueMemoryTurn({ userText: '继续', assistantText: '详细内容' }),
    ).toBe(true)
  })

  it('keeps decisions and technical facts eligible for extraction', () => {
    expect(
      isLowValueMemoryTurn({
        userText: '项目最终改用 PostgreSQL，并保留 pgvector。',
        assistantText: '这个方案可以继续支持向量检索。',
      }),
    ).toBe(false)
  })

  it('normalizes a structured long-term memory', async () => {
    mocks.generateText.mockResolvedValue({
      output: {
        shouldStore: true,
        retrievalText: '项目数据库最终选择 PostgreSQL',
        memoryType: 'decision',
        shouldTrackChanges: true,
        keywords: ['PostgreSQL', 'postgresql', ' pgvector '],
        importance: 0.9,
      },
    })

    await expect(
      extractConversationMemory({
        userText: '项目最终改用 PostgreSQL。',
        assistantText: '已记录该技术决策。',
      }),
    ).resolves.toEqual({
      retrievalText: '项目数据库最终选择 PostgreSQL',
      memoryType: 'decision',
      shouldTrackChanges: true,
      keywords: ['postgresql', 'pgvector'],
      importance: 0.9,
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
}))

vi.mock('ai', () => ({
  embed: mocks.embed,
}))

vi.mock('@/app/lib/ai/provider', () => ({
  EMBEDDING_DIMENSIONS: 1024,
  embeddingModel: { modelId: 'text-embedding-v4' },
}))

import { embedText } from './embedding'

describe('embedText', () => {
  beforeEach(() => {
    mocks.embed.mockReset()
  })

  it('去除文本首尾空白并返回 1024 维向量', async () => {
    const embedding = Array.from({ length: 1024 }, (_, index) => index / 1024)
    mocks.embed.mockResolvedValue({ embedding })

    await expect(embedText('  PostgreSQL 向量检索  ')).resolves.toEqual(
      embedding,
    )
    expect(mocks.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'PostgreSQL 向量检索',
        providerOptions: {
          dashscope: {
            dimensions: 1024,
          },
        },
      }),
    )
  })

  it('拒绝为空白文本生成向量', async () => {
    await expect(embedText('   ')).rejects.toThrow(
      '生成 Embedding 的文本不能为空',
    )
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('拒绝与数据库约定不一致的向量维度', async () => {
    mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2] })

    await expect(embedText('测试文本')).rejects.toThrow(
      'Embedding 维度不正确：预期 1024，实际 2',
    )
  })
})

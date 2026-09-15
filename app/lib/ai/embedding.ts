import { embed } from 'ai'

import {
  EMBEDDING_DIMENSIONS,
  embeddingModel,
} from '@/app/lib/ai/provider'

/**
 * 使用百炼 text-embedding-v4 把一段文本转换成固定长度的向量。
 *
 * 这个函数只允许在服务端调用，因为它会通过 provider 间接使用 API Key。
 * 当前问题和历史记忆都必须调用同一个函数，才能处于相同的向量空间。
 */
export async function embedText(value: string): Promise<number[]> {
  const normalizedValue = value.trim()

  if (!normalizedValue) {
    throw new Error('生成 Embedding 的文本不能为空')
  }

  const { embedding } = await embed({
    model: embeddingModel,
    value: normalizedValue,
    // provider 的 name 是 dashscope，所以这里使用同名配置项。
    // 显式指定维度，保证它与未来 PostgreSQL VECTOR(1024) 一致。
    providerOptions: {
      dashscope: {
        dimensions: EMBEDDING_DIMENSIONS,
      },
    },
  })

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding 维度不正确：预期 ${EMBEDDING_DIMENSIONS}，实际 ${embedding.length}`,
    )
  }

  return embedding
}

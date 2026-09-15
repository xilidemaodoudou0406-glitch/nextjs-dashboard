import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { env } from '@/app/lib/env'

export const deepseek = createOpenAICompatible({
  name: 'deepseek',
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: env.DEEPSEEK_API_KEY,
})

/**
 * 百炼提供 OpenAI 兼容的 Embedding 接口，因此可以继续复用
 * @ai-sdk/openai-compatible，不需要再引入另一套客户端。
 *
 * baseURL 放在环境变量中，是因为它与百炼地域和 WorkspaceId 绑定。
 */
export const dashscope = createOpenAICompatible({
  name: 'dashscope',
  baseURL: env.DASHSCOPE_BASE_URL,
  apiKey: env.DASHSCOPE_API_KEY,
})

// 模型和维度必须固定。已经入库的向量只能与使用同一个模型、同一维度
// 生成的查询向量比较；以后若更换模型，需要重新生成历史向量。
export const EMBEDDING_MODEL_ID = 'text-embedding-v4'
export const EMBEDDING_DIMENSIONS = 1024
export const embeddingModel = dashscope.embeddingModel(
  EMBEDDING_MODEL_ID,
)

export const modelIds = ['deepseek-chat', 'deepseek-reasoner'] as const
export type ModelId = (typeof modelIds)[number]

// 导出几个常用模型，便于后面切换
export const models: Record<ModelId, ReturnType<typeof deepseek>> = {
  'deepseek-chat': deepseek('deepseek-chat'),
  'deepseek-reasoner': deepseek('deepseek-reasoner'),
}
// 这种"集中管理 provider"的写法是工程化习惯。
// 后面切换模型、加新 provider，只改这一个文件

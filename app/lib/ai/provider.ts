import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { env } from '@/app/lib/env'

export const deepseek = createOpenAICompatible({
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY,
})

export const modelIds = ['deepseek-chat', 'deepseek-reasoner'] as const
export type ModelId = (typeof modelIds)[number]

// 导出几个常用模型，便于后面切换
export const models: Record<ModelId, ReturnType<typeof deepseek>> = {
  'deepseek-chat': deepseek('deepseek-chat'),
  'deepseek-reasoner': deepseek('deepseek-reasoner'),
}
// 这种"集中管理 provider"的写法是工程化习惯。
// 后面切换模型、加新 provider，只改这一个文件

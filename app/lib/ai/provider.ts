import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export const deepseek = createOpenAICompatible({
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY!,
})

// 导出几个常用模型，便于后面切换
export const chatModel = deepseek('deepseek-chat')
export const reasonerModel = deepseek('deepseek-reasoner')

// 这种"集中管理 provider"的写法是工程化习惯。
// 后面切换模型、加新 provider，只改这一个文件
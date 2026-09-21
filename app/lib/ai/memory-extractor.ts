import { generateText, Output } from 'ai'
import { z } from 'zod'

import { models } from './provider'

export const memoryTypes = [
  'user_fact',
  'preference',
  'decision',
  'requirement',
  'discussion',
] as const

export type MemoryType = (typeof memoryTypes)[number]

export type ExtractedMemory = {
  // retrievalText 是用于 Embedding/关键词搜索的精简文本，不替代原始消息。
  retrievalText: string
  memoryType: MemoryType
  memoryKey: string | null
  keywords: string[]
  importance: number
}

const extractedMemorySchema = z.object({
  shouldStore: z.boolean(),
  retrievalText: z.string().max(1_200),
  memoryType: z.enum(memoryTypes),
  memoryKey: z.string().max(200).nullable(),
  keywords: z.array(z.string().max(80)).max(12),
  importance: z.number().min(0).max(1),
})

const lowValueUserTextPatterns = [
  /^(你好|您好|嗨|hello|hi)[!！。,.，\s]*$/iu,
  /^(谢谢|感谢|好的|好|知道了|明白了|继续|再说一遍)[!！。,.，\s]*$/u,
]

/**
 * 先用确定性规则拦截明显没有长期价值的轮次，避免每次“谢谢/继续”都调用
 * 一次记忆抽取模型，也避免低价值内容进入向量索引制造噪声。
 */
export function isLowValueMemoryTurn({
  userText,
  assistantText,
}: {
  userText: string
  assistantText: string
}): boolean {
  const normalizedUserText = userText.trim()
  if (!normalizedUserText || !assistantText.trim()) return true

  return lowValueUserTextPatterns.some((pattern) =>
    pattern.test(normalizedUserText),
  )
}

/** 结构化抽取不可用时的保守回退：只索引用户原话，并降低重要性。 */
function fallbackMemory(userText: string): ExtractedMemory {
  return {
    retrievalText: userText.trim().slice(0, 1_200),
    memoryType: 'discussion',
    memoryKey: null,
    keywords: [],
    importance: 0.4,
  }
}

/**
 * 从完整问答中提取一条自包含的长期记忆。
 * 返回 null 表示该轮对话不应进入长期记忆；原始聊天消息仍会正常保存。
 */
export async function extractConversationMemory({
  userText,
  assistantText,
}: {
  userText: string
  assistantText: string
}): Promise<ExtractedMemory | null> {
  if (isLowValueMemoryTurn({ userText, assistantText })) return null

  try {
    const result = await generateText({
      model: models['deepseek-chat'],
      output: Output.object({ schema: extractedMemorySchema }),
      system: [
        '你负责从一轮对话中提取可供未来检索的长期记忆。',
        '只保存用户事实、稳定偏好、已确认决策、明确需求或未来可能引用的重要讨论。',
        '不要把寒暄、无信息量追问、模型未经用户确认的猜测当作稳定事实。',
        'retrievalText 必须简短、自包含并保留错误码、版本号、函数名等精确实体。',
        'memoryKey 仅用于可被未来新值替换的稳定主题，例如 project.database；否则为 null。',
      ].join('\n'),
      prompt: JSON.stringify({ userText, assistantText }),
      maxOutputTokens: 300,
    })

    if (!result.output?.shouldStore) return null

    const retrievalText = result.output.retrievalText.trim()
    if (!retrievalText) return null

    return {
      retrievalText,
      memoryType: result.output.memoryType,
      memoryKey: result.output.memoryKey?.trim() || null,
      keywords: [
        // 去掉空白、统一大小写并去重，便于后续关键词精确匹配。
        ...new Set(
          result.output.keywords
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
        ),
      ],
      importance: result.output.importance,
    }
  } catch (error) {
    // 记忆抽取是增强能力。结构化输出临时失败时仍保留一个低权重讨论记忆，
    // 避免一次外部模型波动让完整对话永远失去索引。
    console.error('提取结构化长期记忆失败，已回退为讨论记忆：', error)
    return fallbackMemory(userText)
  }
}

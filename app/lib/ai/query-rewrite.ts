import { generateText } from 'ai'

import { getMessageText, type ChatMessage } from './message'
import { models } from './provider'

const MAX_REWRITE_CONTEXT_MESSAGES = 6
const MAX_REWRITTEN_QUERY_CHARACTERS = 500

/**
 * 将依赖上文的用户问题改写成可独立搜索的查询。
 * 例如“它和 MongoDB 相比呢？”会补回最近对话中“它”代表的数据库。
 * 该函数只影响召回，不会替换最终交给回答模型的原始用户问题。
 */
export async function rewriteRetrievalQuery({
  query,
  recentMessages,
}: {
  query: string
  recentMessages: ChatMessage[]
}): Promise<string> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return normalizedQuery

  // 只提供最近少量消息用于消解指代，避免改写器被很早的主题干扰。
  const history = recentMessages
    .slice(-MAX_REWRITE_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: getMessageText(message),
    }))
    .filter((message) => message.content.trim().length > 0)

  const { text } = await generateText({
    model: models['deepseek-chat'],
    system: [
      '你是检索查询改写器，不负责回答问题。',
      '结合对话历史，将用户最后的问题改写为可以脱离上下文理解的独立检索查询。',
      '保留错误码、版本号、函数名、数据库名等精确实体。',
      '不要补充对话中没有的信息。只输出一行改写后的查询。',
    ].join('\n'),
    prompt: JSON.stringify({ history, query: normalizedQuery }),
    maxOutputTokens: 160,
  })

  const rewritten = text
    // 部分模型会给单行结果额外包引号，这里统一清理后再参与检索。
    .trim()
    .replace(/^['"“”]|['"“”]$/g, '')
    .slice(0, MAX_REWRITTEN_QUERY_CHARACTERS)

  // 模型意外返回空字符串时回退到原问题，检索链路仍能继续。
  return rewritten || normalizedQuery
}

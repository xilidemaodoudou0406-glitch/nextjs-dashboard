import { getMessageText, type ChatMessage } from './message'
import type { ConversationMemory } from './memory'

export const RRF_RANK_CONSTANT = 60
export const RECENT_CONTEXT_TOKEN_BUDGET = 6_000
export const MEMORY_CONTEXT_TOKEN_BUDGET = 1_600

/** dense 表示向量语义召回，keyword 表示关键词/字符相似度召回。 */
export type RetrievalChannel = 'dense' | 'keyword'

export type RetrievalCandidateTrace = {
  id: string
  score: number
}

export type RetrievalTrace = {
  // originalQuery 用于回答，retrievalQuery 只用于搜索；二者不能混用。
  originalQuery: string
  retrievalQuery: string
  wasRewritten: boolean
  denseCandidates: RetrievalCandidateTrace[]
  keywordCandidates: RetrievalCandidateTrace[]
  selectedMemoryIds: string[]
  fallbackReasons: string[]
  latencyMs: {
    recentMessages: number
    rewrite: number
    dense: number
    keyword: number
    total: number
  }
}

/**
 * 聊天内容以中文为主，不能直接使用“字符数 / 4”估算 Token。
 * 这里不追求替代模型 tokenizer，只提供稳定、保守的上下文预算保护：
 * CJK 字符按 1 token，ASCII 连续文本按约 4 字符 1 token 估算。
 */
export function estimateTextTokens(text: string): number {
  const cjkCharacters = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const remainingCharacters = Math.max(text.length - cjkCharacters, 0)
  return Math.max(Math.ceil(cjkCharacters + remainingCharacters / 4), 1)
}

export function estimateMessageTokens(message: ChatMessage): number {
  const textTokens = estimateTextTokens(getMessageText(message))
  const nonTextParts = message.parts.filter((part) => part.type !== 'text').length

  // 图片等非文本 part 由模型供应商决定实际成本；预留固定额度避免完全忽略。
  return textTokens + nonTextParts * 128 + 8
}

/**
 * 从最新消息开始向前装入上下文，保证离当前问题越近的消息优先保留。
 * 返回前重新反转，使模型最终看到的消息仍然保持正常时间顺序。
 */
export function selectRecentMessagesWithinBudget({
  messages,
  tokenBudget = RECENT_CONTEXT_TOKEN_BUDGET,
}: {
  messages: ChatMessage[]
  tokenBudget?: number
}): ChatMessage[] {
  const safeBudget = Math.max(Math.trunc(tokenBudget), 1)
  const selected: ChatMessage[] = []
  let usedTokens = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const messageTokens = estimateMessageTokens(message)

    // 最新消息无论多长都必须保留，否则模型会看不到当前问题。
    if (selected.length > 0 && usedTokens + messageTokens > safeBudget) {
      break
    }

    selected.push(message)
    usedTokens += messageTokens
  }

  return selected.reverse()
}

/**
 * 记忆已经按融合得分排好序，因此这里按顺序选择即可。
 * 某条记忆过长时跳过它，继续尝试后面更短的候选，避免浪费剩余预算。
 */
export function selectMemoriesWithinBudget({
  memories,
  limit,
  tokenBudget = MEMORY_CONTEXT_TOKEN_BUDGET,
}: {
  memories: ConversationMemory[]
  limit: number
  tokenBudget?: number
}): ConversationMemory[] {
  const selected: ConversationMemory[] = []
  let usedTokens = 0

  for (const memory of memories) {
    if (selected.length >= limit) break

    const memoryTokens = estimateTextTokens(memory.content) + 12
    if (selected.length > 0 && usedTokens + memoryTokens > tokenBudget) {
      continue
    }

    selected.push(memory)
    usedTokens += memoryTokens
  }

  return selected
}

/**
 * 查询改写会额外调用一次 LLM，因此只对明显依赖上文的问题启用。
 * 清晰、独立的问题直接进入检索，避免无意义地增加首 Token 延迟。
 */
export function shouldRewriteRetrievalQuery(query: string): boolean {
  const normalized = query.trim()
  if (!normalized) return false

  const hasReference =
    /(^|[，。！？\s])(它们?|这个|那个|这件事|那件事|该方案|上述|前面|上面|刚才)/u.test(
      normalized,
    )
  const isVeryShortQuestion = normalized.length <= 8 && /[？?]$/u.test(normalized)

  return hasReference || isVeryShortQuestion
}

/**
 * 关键词通道优先补足向量检索不擅长的错误码、版本号、函数名和专有名词。
 * 长中文自然语言仍交给 dense retrieval，避免把整句话当成一个精确词。
 */
export function extractKeywordTerms(query: string): string[] {
  const matches = query.match(/[A-Za-z0-9_./:@-]{2,}/g) ?? []
  return [...new Set(matches.map((value) => value.toLowerCase()))].slice(0, 12)
}

export function fuseConversationMemoryResults({
  dense,
  keyword,
  rankConstant = RRF_RANK_CONSTANT,
}: {
  dense: ConversationMemory[]
  keyword: ConversationMemory[]
  rankConstant?: number
}): ConversationMemory[] {
  // RRF 只使用候选的“排名”，不直接比较余弦分数和关键词分数。
  // 这样能够规避两种分数取值范围不同、难以手工设置权重的问题。
  const fused = new Map<
    string,
    { memory: ConversationMemory; score: number; channels: RetrievalChannel[] }
  >()

  const addResults = (
    memories: ConversationMemory[],
    channel: RetrievalChannel,
  ) => {
    memories.forEach((memory, index) => {
      // 排名越靠前，贡献越大；rankConstant 用于减小头部名次的极端差异。
      const rankScore = 1 / (rankConstant + index + 1)
      const existing = fused.get(memory.id)

      if (existing) {
        // 同一记忆同时被两条通道命中时累加得分，因此会自然排到更前面。
        existing.score += rankScore
        if (!existing.channels.includes(channel)) {
          existing.channels.push(channel)
        }
        existing.memory = {
          ...existing.memory,
          denseSimilarity:
            existing.memory.denseSimilarity ?? memory.denseSimilarity,
          keywordSimilarity:
            existing.memory.keywordSimilarity ?? memory.keywordSimilarity,
        }
        return
      }

      fused.set(memory.id, {
        memory,
        score: rankScore,
        channels: [channel],
      })
    })
  }

  addResults(dense, 'dense')
  addResults(keyword, 'keyword')

  return [...fused.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      // RRF 相同时才使用记忆重要性打破平局，不让重要性覆盖相关性排序。
      return right.memory.importance - left.memory.importance
    })
    .map(({ memory, score, channels }) => ({
      ...memory,
      retrievalScore: score,
      retrievalChannels: channels,
    }))
}

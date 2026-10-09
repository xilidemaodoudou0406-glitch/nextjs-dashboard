import { describe, expect, it } from 'vitest'

import type { ChatMessage } from './message'
import type { ConversationMemory } from './memory'
import {
  estimateTextTokens,
  fuseConversationMemoryResults,
  selectRecentMessagesWithinBudget,
  shouldRewriteRetrievalQuery,
} from './retrieval'

function message(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  }
}

function memory(
  id: string,
  overrides: Partial<ConversationMemory> = {},
): ConversationMemory {
  return {
    id,
    chatId: 'chat-id',
    content: `记忆 ${id}`,
    similarity: 0.8,
    denseSimilarity: 0.8,
    bm25Score: null,
    retrievalScore: 0.8,
    retrievalChannels: ['dense'],
    retrievalText: `检索文本 ${id}`,
    memoryType: 'discussion',
    memoryKey: null,
    importance: 0.5,
    sourceUserMessageId: `${id}-user`,
    sourceAssistantMessageId: `${id}-assistant`,
    ...overrides,
  }
}

describe('RAG retrieval helpers', () => {
  it('detects context-dependent questions without rewriting clear queries', () => {
    expect(shouldRewriteRetrievalQuery('它相比 MongoDB 有什么优势？')).toBe(true)
    expect(shouldRewriteRetrievalQuery('这个呢？')).toBe(true)
    expect(
      shouldRewriteRetrievalQuery('PostgreSQL 相比 MongoDB 有什么优势？'),
    ).toBe(false)
  })

  it('gives candidates found by both channels a higher RRF score', () => {
    const both = memory('both')
    const denseOnly = memory('dense-only')
    const bm25Both = memory('both', {
      denseSimilarity: null,
      bm25Score: 3.9,
      retrievalChannels: ['bm25'],
    })
    const bm25Only = memory('bm25-only', {
      denseSimilarity: null,
      bm25Score: 2.85,
      retrievalChannels: ['bm25'],
    })

    const fused = fuseConversationMemoryResults({
      dense: [denseOnly, both],
      bm25: [bm25Both, bm25Only],
    })

    expect(fused[0].id).toBe('both')
    expect(fused[0].retrievalChannels).toEqual(['dense', 'bm25'])
  })

  it('keeps the latest message even when it exceeds the token budget', () => {
    const selected = selectRecentMessagesWithinBudget({
      messages: [
        message('old', '很早的消息'),
        message('latest', '最'.repeat(200)),
      ],
      tokenBudget: 20,
    })

    expect(selected.map(({ id }) => id)).toEqual(['latest'])
    expect(estimateTextTokens('中文abc')).toBeGreaterThan(2)
  })
})

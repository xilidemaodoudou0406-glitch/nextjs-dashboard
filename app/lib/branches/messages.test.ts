import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/app/lib/ai/message'
import type { BranchConversation } from '@/app/lib/branches/types'
import {
  buildBranchInitialMessages,
  getVisibleBranchMessages,
} from './messages'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): ChatMessage {
  return {
    id,
    role,
    metadata: { persistenceStatus: 'completed' },
    parts: [{ type: 'text', text }],
  }
}

const conversation: BranchConversation = {
  branch: {
    id: '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4',
    parentChatId: '3d60516d-3443-4faa-862c-6c96f3eafa19',
    anchorMessageId: '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
    title: '分支：锚点回答',
    createdAt: '2026-07-31T08:00:00.000Z',
  },
  anchorMessage: message(
    '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
    'assistant',
    '锚点回答',
  ),
  inheritedMessages: [
    message('065c30b8-a52a-48e1-87bd-b1e2801a88f9', 'user', '主问题'),
    message(
      '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
      'assistant',
      '锚点回答',
    ),
  ],
  branchMessages: [
    message(
      '663749b6-d80e-42d7-9bc8-0860453f5444',
      'user',
      '分支问题',
    ),
  ],
}

describe('branch message boundaries', () => {
  it('keeps inherited messages in the model context but outside the visible list', () => {
    const modelMessages = buildBranchInitialMessages(conversation)
    const visibleMessages = getVisibleBranchMessages(
      modelMessages,
      conversation.inheritedMessages.length,
    )

    expect(modelMessages).toHaveLength(3)
    expect(visibleMessages.map(({ id }) => id)).toEqual([
      '663749b6-d80e-42d7-9bc8-0860453f5444',
    ])
  })

  it('removes the pending first message before useChat sends it with the same ID', () => {
    const modelMessages = buildBranchInitialMessages(conversation, {
      id: '663749b6-d80e-42d7-9bc8-0860453f5444',
      content: '分支问题',
    })

    expect(modelMessages.map(({ id }) => id)).toEqual([
      '065c30b8-a52a-48e1-87bd-b1e2801a88f9',
      '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
    ])
  })
})

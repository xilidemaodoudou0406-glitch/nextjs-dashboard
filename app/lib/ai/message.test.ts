import { describe, expect, it } from 'vitest'

import {
  getMessagePersistenceStatus,
  isChatRequestInProgress,
  isMessageStableForActions,
  type ChatMessage,
} from './message'

describe('chat state contract', () => {
  it('keeps transient request states separate from message persistence', () => {
    expect(isChatRequestInProgress('submitted')).toBe(true)
    expect(isChatRequestInProgress('streaming')).toBe(true)
    expect(isChatRequestInProgress('ready')).toBe(false)
    expect(isChatRequestInProgress('error')).toBe(false)
  })

  it('maps a generation result to its persistence status', () => {
    expect(getMessagePersistenceStatus(false)).toBe('completed')
    expect(getMessagePersistenceStatus(true)).toBe('interrupted')
  })

  it('only enables persisted actions for completed assistant messages', () => {
    const completedMessage: ChatMessage = {
      id: '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
      role: 'assistant',
      metadata: { persistenceStatus: 'completed' },
      parts: [{ type: 'text', text: '完整回答' }],
    }
    const interruptedMessage: ChatMessage = {
      ...completedMessage,
      metadata: { persistenceStatus: 'interrupted' },
    }

    expect(isMessageStableForActions(completedMessage)).toBe(true)
    expect(isMessageStableForActions(interruptedMessage)).toBe(false)
  })
})

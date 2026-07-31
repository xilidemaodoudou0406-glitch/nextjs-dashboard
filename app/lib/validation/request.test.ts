import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/lib/ai/provider', () => ({
  modelIds: ['deepseek-chat', 'deepseek-reasoner'] as const,
}))

import {
  branchAnchorSchema,
  branchFirstSubmitSchema,
  branchIdentitySchema,
  chatRequestSchema,
} from './request'

const chatId = '3d60516d-3443-4faa-862c-6c96f3eafa19'
const firstUserMessageId = '065c30b8-a52a-48e1-87bd-b1e2801a88f9'
const assistantMessageId = '535823cd-d4d2-4341-bb7b-37bbef72c1e7'
const secondUserMessageId = '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4'
describe('chatRequestSchema', () => {
  it('accepts AI SDK assistant parts in a multi-turn request', () => {
    const result = chatRequestSchema.safeParse({
      id: chatId,
      messages: [
        {
          id: firstUserMessageId,
          role: 'user',
          parts: [{ type: 'text', text: '第一个问题' }],
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: '思考过程', state: 'done' },
            { type: 'text', text: '第一个回答', state: 'done' },
          ],
        },
        {
          id: secondUserMessageId,
          role: 'user',
          parts: [{ type: 'text', text: '第二个问题' }],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it('still rejects unsupported message part types', () => {
    const result = chatRequestSchema.safeParse({
      id: chatId,
      messages: [
        {
          id: firstUserMessageId,
          role: 'user',
          parts: [{ type: 'unknown-part' }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  it.each(['completed', 'interrupted'] as const)(
    'accepts the %s persistence status without mixing it with request status',
    (persistenceStatus) => {
      const result = chatRequestSchema.safeParse({
        id: chatId,
        messages: [
          {
            id: assistantMessageId,
            role: 'assistant',
            metadata: { persistenceStatus },
            parts: [{ type: 'text', text: '回答' }],
          },
        ],
      })

      expect(result.success).toBe(true)
    },
  )

  it('rejects request lifecycle values used as persistence status', () => {
    const result = chatRequestSchema.safeParse({
      id: chatId,
      messages: [
        {
          id: assistantMessageId,
          role: 'assistant',
          metadata: { persistenceStatus: 'streaming' },
          parts: [{ type: 'text', text: '回答' }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  it('rejects a message id that is not a UUID', () => {
    const result = chatRequestSchema.safeParse({
      id: chatId,
      messages: [
        {
          id: 'not-a-uuid',
          role: 'user',
          parts: [{ type: 'text', text: '消息' }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })
})

describe('branch request schemas', () => {
  it('accepts UUID relationships used by branch actions', () => {
    expect(
      branchAnchorSchema.safeParse({
        parentChatId: chatId,
        anchorMessageId: assistantMessageId,
      }).success,
    ).toBe(true)

    expect(
      branchIdentitySchema.safeParse({
        parentChatId: chatId,
        branchId: secondUserMessageId,
      }).success,
    ).toBe(true)

    expect(
      branchFirstSubmitSchema.safeParse({
        parentChatId: chatId,
        anchorMessageId: assistantMessageId,
        firstMessage: {
          id: secondUserMessageId,
          content: '分支问题',
        },
      }).success,
    ).toBe(true)
  })

  it('rejects non-UUID branch relationship ids', () => {
    expect(
      branchAnchorSchema.safeParse({
        parentChatId: chatId,
        anchorMessageId: 'assistant-1',
      }).success,
    ).toBe(false)
  })

  it('rejects an empty first branch message', () => {
    expect(
      branchFirstSubmitSchema.safeParse({
        parentChatId: chatId,
        anchorMessageId: assistantMessageId,
        firstMessage: {
          id: secondUserMessageId,
          content: '   ',
        },
      }).success,
    ).toBe(false)
  })
})

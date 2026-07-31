import { beforeEach, describe, expect, it, vi } from 'vitest'

type SqlCall = {
  text: string
  values: unknown[]
}

type UIStreamFinishEvent = {
  responseMessage: {
    id: string
    role: 'assistant'
    parts: { type: 'text'; text: string }[]
  }
  isAborted: boolean
  finishReason?: string
}

type UIResponseOptions = {
  originalMessages?: unknown[]
  generateMessageId?: () => string
  onFinish?: (event: UIStreamFinishEvent) => Promise<void>
}

const mocks = vi.hoisted(() => ({
  sqlCalls: [] as SqlCall[],
  uiResponseOptions: undefined as UIResponseOptions | undefined,
  userMessageAlreadyExists: false,
}))

vi.mock('postgres', () => ({
  default: () => async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    mocks.sqlCalls.push({ text, values })

    if (text.startsWith('SELECT id FROM chats')) {
      return [{ id: '3d60516d-3443-4faa-862c-6c96f3eafa19' }]
    }

    if (text.startsWith('INSERT INTO messages')) {
      if (
        mocks.userMessageAlreadyExists &&
        text.includes("'user'")
      ) {
        return []
      }

      return [{ id: values[0] }]
    }

    if (text.startsWith('SELECT message.id')) {
      return [{ id: values[0] }]
    }

    return []
  },
}))

vi.mock('@/app/lib/env', () => ({
  env: {
    POSTGRES_URL: 'postgres://test',
    DEEPSEEK_API_KEY: 'test-key',
  },
}))

vi.mock('@/app/lib/auth/require-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'adad85e4-e660-4e9b-a7f5-b19848230d33',
  })),
}))

vi.mock('@/app/lib/ai/provider', () => ({
  modelIds: ['deepseek-chat', 'deepseek-reasoner'] as const,
  models: {
    'deepseek-chat': {},
    'deepseek-reasoner': {},
  },
}))

vi.mock('ai', () => ({
  convertToModelMessages: vi.fn(async (messages: unknown[]) => messages),
  generateText: vi.fn(),
  streamText: vi.fn(() => ({
    toUIMessageStreamResponse: (responseOptions: UIResponseOptions) => {
      mocks.uiResponseOptions = responseOptions
      return new Response(null, { status: 200 })
    },
  })),
}))

import { POST } from './route'

const chatId = '3d60516d-3443-4faa-862c-6c96f3eafa19'
const userMessageId = '065c30b8-a52a-48e1-87bd-b1e2801a88f9'

async function startChatRequest() {
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        id: chatId,
        modelId: 'deepseek-chat',
        messages: [
          {
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: '你好' }],
          },
        ],
      }),
    }),
  )
}

describe('POST /api/chat message persistence', () => {
  beforeEach(() => {
    mocks.sqlCalls.length = 0
    mocks.uiResponseOptions = undefined
    mocks.userMessageAlreadyExists = false
  })

  it('uses one ID for the user UI message and database record', async () => {
    const response = await startChatRequest()
    expect(response.status).toBe(200)

    const userInsert = mocks.sqlCalls.find(({ text }) =>
      text.startsWith('INSERT INTO messages'),
    )

    expect(userInsert?.values[0]).toBe(userMessageId)
    expect(userInsert?.text).toContain("'completed'")
  })

  it('accepts the first branch message when the creation transaction already persisted it', async () => {
    mocks.userMessageAlreadyExists = true

    const response = await startChatRequest()

    expect(response.status).toBe(200)
    expect(
      mocks.sqlCalls.some(({ text }) =>
        text.startsWith('SELECT message.id'),
      ),
    ).toBe(true)
  })

  it.each([
    { isAborted: false, expectedStatus: 'completed' },
    { isAborted: true, expectedStatus: 'interrupted' },
  ])(
    'persists the assistant UI ID with $expectedStatus status',
    async ({ isAborted, expectedStatus }) => {
      await startChatRequest()

      const assistantMessageId =
        mocks.uiResponseOptions?.generateMessageId?.()
      expect(assistantMessageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )

      await mocks.uiResponseOptions?.onFinish?.({
        responseMessage: {
          id: assistantMessageId!,
          role: 'assistant',
          parts: [{ type: 'text', text: '回答内容' }],
        },
        isAborted,
        finishReason: isAborted ? undefined : 'stop',
      })

      const messageInserts = mocks.sqlCalls.filter(({ text }) =>
        text.startsWith('INSERT INTO messages'),
      )
      const assistantInsert = messageInserts[1]

      expect(assistantInsert.values[0]).toBe(assistantMessageId)
      expect(assistantInsert.values[2]).toBe(expectedStatus)
    },
  )

  it('does not persist partial assistant content from a model error', async () => {
    await startChatRequest()

    const assistantMessageId =
      mocks.uiResponseOptions?.generateMessageId?.()
    await mocks.uiResponseOptions?.onFinish?.({
      responseMessage: {
        id: assistantMessageId!,
        role: 'assistant',
        parts: [{ type: 'text', text: '未完成的异常回答' }],
      },
      isAborted: false,
      finishReason: 'error',
    })

    const messageInserts = mocks.sqlCalls.filter(({ text }) =>
      text.startsWith('INSERT INTO messages'),
    )
    expect(messageInserts).toHaveLength(1)
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/app/lib/ai/message'
import type { BranchConversation } from '@/app/lib/branches/types'

const mocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  regenerate: vi.fn(),
  transport: vi.fn(),
  renderedMessages: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: mocks.useChat,
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {
    constructor(options: unknown) {
      mocks.transport(options)
    }
  },
}))

vi.mock('../messages', () => ({
  default: (props: { messages: ChatMessage[] }) => {
    mocks.renderedMessages(props.messages)
    return <div>分支消息列表</div>
  },
}))

vi.mock('./branch-composer', () => ({
  default: () => <div>分支输入框</div>,
}))

import BranchChat from './branch-chat'

const parentChatId = '3d60516d-3443-4faa-862c-6c96f3eafa19'
const anchorMessageId = '535823cd-d4d2-4341-bb7b-37bbef72c1e7'
const branchId = '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4'
const firstMessageId = '663749b6-d80e-42d7-9bc8-0860453f5444'

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

const inheritedMessage = message(
  anchorMessageId,
  'assistant',
  '锚点回答',
)
const firstBranchMessage = message(
  firstMessageId,
  'user',
  '请解释这部分',
)
const conversation: BranchConversation = {
  branch: {
    id: branchId,
    parentChatId,
    anchorMessageId,
    title: '分支：锚点回答',
    createdAt: '2026-07-31T08:00:00.000Z',
  },
  anchorMessage: inheritedMessage,
  inheritedMessages: [inheritedMessage],
  branchMessages: [firstBranchMessage],
}

describe('BranchChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessage.mockResolvedValue(undefined)
    mocks.regenerate.mockResolvedValue(undefined)
    mocks.useChat.mockReturnValue({
      messages: [inheritedMessage, firstBranchMessage],
      sendMessage: mocks.sendMessage,
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
      clearError: vi.fn(),
      regenerate: mocks.regenerate,
    })
  })

  it('keeps inherited context in useChat but renders only branch messages', async () => {
    render(
      <BranchChat
        conversation={conversation}
        modelId="deepseek-chat"
      />,
    )

    expect(screen.getByText('分支消息列表')).toBeInTheDocument()
    expect(mocks.useChat).toHaveBeenCalledWith(
      expect.objectContaining({
        id: branchId,
        messages: [inheritedMessage, firstBranchMessage],
      }),
    )
    expect(mocks.renderedMessages).toHaveBeenCalledWith([
      firstBranchMessage,
    ])
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        api: '/api/chat',
        body: {
          id: branchId,
          chatMode: 'branch',
          modelId: 'deepseek-chat',
        },
        prepareSendMessagesRequest: expect.any(Function),
      }),
    )

    const transportOptions = mocks.transport.mock.calls[0][0]
    expect(
      transportOptions.prepareSendMessagesRequest({
        body: transportOptions.body,
        messages: [inheritedMessage, firstBranchMessage],
      }),
    ).toEqual({
      body: {
        id: branchId,
        chatMode: 'branch',
        modelId: 'deepseek-chat',
        messages: [firstBranchMessage],
      },
    })
  })

  it('sends the persisted first message with the same client-generated ID', async () => {
    render(
      <BranchChat
        conversation={conversation}
        modelId="deepseek-chat"
        pendingFirstMessage={{
          id: firstMessageId,
          content: '请解释这部分',
        }}
      />,
    )

    // pending 消息会先从 useChat 初始化数组移除，再由 sendMessage 加入一次。
    expect(mocks.useChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [inheritedMessage],
      }),
    )
    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        id: firstMessageId,
        role: 'user',
        parts: [{ type: 'text', text: '请解释这部分' }],
      })
    })
  })

  it('regenerates an unanswered persisted user message without inserting another one', () => {
    render(
      <BranchChat
        conversation={conversation}
        modelId="deepseek-chat"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: '重新生成回答' }),
    )

    expect(mocks.regenerate).toHaveBeenCalledWith({
      messageId: firstMessageId,
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})

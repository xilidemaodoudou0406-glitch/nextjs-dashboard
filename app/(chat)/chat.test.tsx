import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  useChat: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: mocks.useChat,
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock('@/app/components/suggestions', () => ({
  Suggestions: ({
    onSend,
  }: {
    onSend: (text: string) => void
  }) => (
    <button onClick={() => onSend('测试问题')} type="button">
      发送建议问题
    </button>
  ),
}))

vi.mock('./chat-input', () => ({
  default: () => <div>主输入框</div>,
}))

vi.mock('./messages', () => ({
  default: () => <div>消息列表</div>,
}))

vi.mock('./branch/branch-panel', () => ({
  default: () => <div>分支面板</div>,
}))

import Chat from './chat'

describe('Chat message identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessage.mockResolvedValue(undefined)
    mocks.useChat.mockReturnValue({
      messages: [],
      sendMessage: mocks.sendMessage,
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
    })
  })

  it('uses id for a new AI SDK message instead of the replacement-only messageId', () => {
    const messageId = '094291d1-67c5-4faa-9797-1125ba18d801'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(messageId)

    render(
      <Chat chatId="3d60516d-3443-4faa-862c-6c96f3eafa19" />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '发送建议问题' }),
    )

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      id: messageId,
      role: 'user',
      parts: [{ type: 'text', text: '测试问题' }],
    })
    expect(mocks.sendMessage.mock.calls[0][0]).not.toHaveProperty(
      'messageId',
    )
  })
})

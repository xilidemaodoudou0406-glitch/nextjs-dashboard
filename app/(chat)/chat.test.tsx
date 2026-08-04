import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  branchPanel: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  regenerate: vi.fn(),
  replace: vi.fn(),
  search: '',
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
  usePathname: () => '/chat/3d60516d-3443-4faa-862c-6c96f3eafa19',
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
    replace: mocks.replace,
  }),
  useSearchParams: () => new URLSearchParams(mocks.search),
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
  default: (props: unknown) => {
    mocks.branchPanel(props)
    return <div>分支面板</div>
  },
}))

import Chat from './chat'

describe('Chat message identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search = ''
    mocks.sendMessage.mockResolvedValue(undefined)
    mocks.regenerate.mockResolvedValue(undefined)
    mocks.useChat.mockReturnValue({
      messages: [],
      sendMessage: mocks.sendMessage,
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
      clearError: vi.fn(),
      regenerate: mocks.regenerate,
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

  it('regenerates the last persisted user message after a failed response', () => {
    const unansweredMessage = {
      id: '065c30b8-a52a-48e1-87bd-b1e2801a88f9',
      role: 'user' as const,
      metadata: { persistenceStatus: 'completed' as const },
      parts: [{ type: 'text' as const, text: '没有得到回答的问题' }],
    }
    mocks.useChat.mockReturnValue({
      messages: [unansweredMessage],
      sendMessage: mocks.sendMessage,
      status: 'ready',
      stop: vi.fn(),
      error: undefined,
      clearError: vi.fn(),
      regenerate: mocks.regenerate,
    })

    render(
      <Chat chatId="3d60516d-3443-4faa-9797-1125ba18d801" />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '重新生成回答' }),
    )

    expect(mocks.regenerate).toHaveBeenCalledWith({
      messageId: unansweredMessage.id,
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('restores a persisted branch from the URL query parameter', () => {
    const branchId = '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4'
    mocks.search = `branch=${branchId}`

    render(
      <Chat chatId="3d60516d-3443-4faa-9797-1125ba18d801" />,
    )

    expect(screen.getByText('分支面板')).toBeInTheDocument()
    expect(mocks.branchPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'branch', branchId },
      }),
    )
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import Messages from './messages'
import type { ChatMessage } from '@/app/lib/ai/message'

vi.mock('@/app/components/message-feedback', () => ({
  MessageFeedback: () => <button aria-label="点赞" />,
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
})

function createAssistantMessage(
  persistenceStatus: 'completed' | 'interrupted',
): ChatMessage {
  return {
    id: '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
    role: 'assistant',
    metadata: { persistenceStatus },
    parts: [{ type: 'text', text: '回答内容' }],
  }
}

describe('Messages actions', () => {
  it('shows feedback only for completed assistant messages', () => {
    const { rerender } = render(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[createAssistantMessage('completed')]}
        status="ready"
      />,
    )

    expect(screen.getByRole('button', { name: '点赞' })).toBeInTheDocument()

    const generatingMessage: ChatMessage = {
      ...createAssistantMessage('completed'),
      metadata: undefined,
    }
    rerender(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[generatingMessage]}
        status="streaming"
      />,
    )
    expect(screen.queryByRole('button', { name: '点赞' })).not.toBeInTheDocument()

    rerender(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[createAssistantMessage('interrupted')]}
        status="ready"
      />,
    )

    expect(screen.queryByRole('button', { name: '点赞' })).not.toBeInTheDocument()
    expect(screen.getByText('已停止生成')).toBeInTheDocument()
  })

  it('shows the branch entry only when the main chat supplies an open handler', () => {
    const onOpenBranch = vi.fn()
    const completedMessage = createAssistantMessage('completed')
    const { rerender } = render(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[completedMessage]}
        onOpenBranch={onOpenBranch}
        status="ready"
      />,
    )

    const branchButton = screen.getByRole('button', {
      name: '基于这条回答打开分支',
    })
    fireEvent.click(branchButton)
    expect(onOpenBranch).toHaveBeenCalledWith(
      completedMessage,
      branchButton,
    )

    // BranchChat 不传 onOpenBranch，因此分支回答不会继续产生嵌套分支。
    rerender(
      <Messages
        chatId="8d0ca8bc-02b7-4345-9f04-3142a3f29cc4"
        messages={[completedMessage]}
        status="ready"
      />,
    )
    expect(
      screen.queryByRole('button', {
        name: '基于这条回答打开分支',
      }),
    ).not.toBeInTheDocument()
  })

  it('stops following when the user reads upward and offers a return button', () => {
    render(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[createAssistantMessage('completed')]}
        status="streaming"
      />,
    )

    const messageLog = screen.getByRole('log')
    Object.defineProperties(messageLog, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100, writable: true },
    })
    fireEvent.scroll(messageLog)

    const returnButton = screen.getByRole('button', {
      name: '回到底部',
    })
    expect(returnButton).toBeInTheDocument()

    fireEvent.click(returnButton)
    expect(messageLog.scrollTo).toHaveBeenCalledWith({
      top: 1_000,
      behavior: 'smooth',
    })
    expect(
      screen.queryByRole('button', { name: '回到底部' }),
    ).not.toBeInTheDocument()
  })

  it('resumes only after a downward wheel gesture reaches the bottom area', () => {
    const generatingMessage: ChatMessage = {
      ...createAssistantMessage('completed'),
      metadata: undefined,
    }
    const { rerender } = render(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[generatingMessage]}
        status="streaming"
      />,
    )

    const messageLog = screen.getByRole('log')
    Object.defineProperties(messageLog, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      // 距离底部只有 10px，仍处于原来的 80px 自动跟随区域内。
      scrollTop: { configurable: true, value: 590, writable: true },
    })

    const scrollTo = vi.mocked(messageLog.scrollTo)
    scrollTo.mockClear()

    fireEvent.wheel(messageLog, { deltaY: -1 })
    fireEvent.scroll(messageLog)

    expect(
      screen.getByRole('button', { name: '回到底部' }),
    ).toBeInTheDocument()

    // 模拟下一个流式片段到达；暂停锁存在时不能再次滚到底部。
    rerender(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[
          {
            ...generatingMessage,
            parts: [{ type: 'text', text: '回答内容+' }],
          },
        ]}
        status="streaming"
      />,
    )

    expect(scrollTo).not.toHaveBeenCalled()

    // 单纯进入底部附近不会恢复跟随，因为还没有出现向下滚轮动作。
    messageLog.scrollTop = 530
    fireEvent.scroll(messageLog)
    expect(
      screen.getByRole('button', { name: '回到底部' }),
    ).toBeInTheDocument()

    fireEvent.wheel(messageLog, { deltaY: 1 })
    expect(
      screen.queryByRole('button', { name: '回到底部' }),
    ).not.toBeInTheDocument()

    rerender(
      <Messages
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messages={[
          {
            ...generatingMessage,
            parts: [{ type: 'text', text: '回答内容++' }],
          },
        ]}
        status="streaming"
      />,
    )

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1_000,
      behavior: 'auto',
    })
  })
})

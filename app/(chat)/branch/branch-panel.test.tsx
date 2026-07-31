import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/app/lib/ai/message'
import type { BranchConversation } from '@/app/lib/branches/types'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  branchChat: vi.fn(),
}))

vi.mock('../branch-actions', () => ({
  findBranchByAnchor: mocks.find,
  createBranchOnFirstSubmit: mocks.create,
  readBranchConversation: mocks.read,
}))

vi.mock('./branch-chat', () => ({
  default: (props: {
    conversation: BranchConversation
    pendingFirstMessage?: { id: string; content: string }
  }) => {
    mocks.branchChat(props)
    return <div>已加载分支聊天</div>
  },
}))

import BranchPanel from './branch-panel'

const parentChatId = '3d60516d-3443-4faa-862c-6c96f3eafa19'
const anchorMessageId = '535823cd-d4d2-4341-bb7b-37bbef72c1e7'
const branchId = '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4'
const firstMessageId = '663749b6-d80e-42d7-9bc8-0860453f5444'

const anchorMessage: ChatMessage = {
  id: anchorMessageId,
  role: 'assistant',
  metadata: { persistenceStatus: 'completed' },
  parts: [{ type: 'text', text: '锚点回答内容' }],
}

const conversation: BranchConversation = {
  branch: {
    id: branchId,
    parentChatId,
    anchorMessageId,
    title: '分支：锚点回答',
    createdAt: '2026-07-31T08:00:00.000Z',
  },
  anchorMessage,
  inheritedMessages: [anchorMessage],
  branchMessages: [
    {
      id: firstMessageId,
      role: 'user',
      metadata: { persistenceStatus: 'completed' },
      parts: [{ type: 'text', text: '请解释这部分' }],
    },
  ],
}

function renderPanel() {
  return render(
    <BranchPanel
      anchorMessage={anchorMessage}
      modelId="deepseek-chat"
      onClose={vi.fn()}
      parentChatId={parentChatId}
    />,
  )
}

describe('BranchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      firstMessageId,
    )
  })

  it('opens a draft without creating a database branch', async () => {
    mocks.find.mockResolvedValueOnce({
      ok: true,
      data: {
        parentChatId,
        anchorMessageId,
        anchorPreview: '锚点回答内容',
        inheritedMessageCount: 4,
        branch: null,
      },
    })

    renderPanel()

    expect(
      await screen.findByText('这是一个临时草稿'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('已继承主对话截至此处的 4 条消息'),
    ).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('creates on first submit and reuses the client message ID for BranchChat', async () => {
    mocks.find.mockResolvedValueOnce({
      ok: true,
      data: {
        parentChatId,
        anchorMessageId,
        anchorPreview: '锚点回答内容',
        inheritedMessageCount: 1,
        branch: null,
      },
    })
    mocks.create.mockResolvedValueOnce({
      ok: true,
      data: conversation.branch,
    })
    mocks.read.mockResolvedValueOnce({
      ok: true,
      data: conversation,
    })

    renderPanel()

    const input = await screen.findByRole('textbox', {
      name: '分支问题',
    })
    fireEvent.change(input, {
      target: { value: '请解释这部分' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '发送分支问题' }),
    )

    await screen.findByText('已加载分支聊天')
    expect(mocks.create).toHaveBeenCalledWith({
      parentChatId,
      anchorMessageId,
      firstMessage: {
        id: firstMessageId,
        content: '请解释这部分',
      },
    })
    expect(mocks.read).toHaveBeenCalledWith({
      parentChatId,
      branchId,
    })

    await waitFor(() => {
      expect(mocks.branchChat).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingFirstMessage: {
            id: firstMessageId,
            content: '请解释这部分',
          },
        }),
      )
    })
  })

  it('loads an existing branch without calling the create action', async () => {
    mocks.find.mockResolvedValueOnce({
      ok: true,
      data: {
        parentChatId,
        anchorMessageId,
        anchorPreview: '锚点回答内容',
        inheritedMessageCount: 1,
        branch: conversation.branch,
      },
    })
    mocks.read.mockResolvedValueOnce({
      ok: true,
      data: conversation,
    })

    renderPanel()

    expect(
      await screen.findByText('已加载分支聊天'),
    ).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.read).toHaveBeenCalledWith({
      parentChatId,
      branchId,
    })
  })
})

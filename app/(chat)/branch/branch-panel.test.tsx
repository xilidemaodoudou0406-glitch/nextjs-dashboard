import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/app/lib/ai/message'
import type { BranchConversation } from '@/app/lib/branches/types'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  read: vi.fn(),
  branchChat: vi.fn(),
  close: vi.fn(),
  deleted: vi.fn(),
  persisted: vi.fn(),
  stop: vi.fn(async () => undefined),
}))

vi.mock('../branch-actions', () => ({
  findBranchByAnchor: mocks.find,
  createBranchOnFirstSubmit: mocks.create,
  deleteBranch: mocks.delete,
  readBranchConversation: mocks.read,
}))

vi.mock('./branch-chat', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  return {
    default: React.forwardRef(function MockBranchChat(
      props: {
        conversation: BranchConversation
        pendingFirstMessage?: { id: string; content: string }
      },
      ref: React.ForwardedRef<{
        isBusy: () => boolean
        stopGeneration: () => Promise<void>
      }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        isBusy: () => false,
        stopGeneration: mocks.stop,
      }))
      mocks.branchChat(props)
      return <div>已加载分支聊天</div>
    }),
  }
})

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

function renderPanel(
  initialSource:
    | { kind: 'anchor'; anchorMessage: ChatMessage }
    | { kind: 'branch'; branchId: string } = {
      kind: 'anchor',
      anchorMessage,
    },
) {
  function Harness() {
    const [source, setSource] = useState<
      | { kind: 'anchor'; anchorMessage: ChatMessage }
      | { kind: 'branch'; branchId: string }
    >(initialSource)

    return (
      <BranchPanel
        modelId="deepseek-chat"
        onBranchPersisted={(nextBranchId) => {
          mocks.persisted(nextBranchId)
          setSource({ kind: 'branch', branchId: nextBranchId })
        }}
        onClose={mocks.close}
        onDeleted={mocks.deleted}
        parentChatId={parentChatId}
        source={source}
      />
    )
  }

  return render(<Harness />)
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
    expect(mocks.persisted).toHaveBeenCalledWith(branchId)

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
    expect(mocks.persisted).toHaveBeenCalledWith(branchId)
    expect(mocks.read).toHaveBeenCalledWith({
      parentChatId,
      branchId,
    })
  })

  it('restores a branch directly from a URL branch id', async () => {
    mocks.read.mockResolvedValueOnce({
      ok: true,
      data: conversation,
    })

    renderPanel({ kind: 'branch', branchId })

    expect(
      await screen.findByText('已加载分支聊天'),
    ).toBeInTheDocument()
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.read).toHaveBeenCalledWith({
      parentChatId,
      branchId,
    })
  })

  it('deletes a persisted branch without deleting the parent chat', async () => {
    mocks.read.mockResolvedValueOnce({
      ok: true,
      data: conversation,
    })
    mocks.delete.mockResolvedValueOnce({
      ok: true,
      data: { branchId },
    })

    renderPanel({ kind: 'branch', branchId })
    await screen.findByText('已加载分支聊天')

    fireEvent.click(
      screen.getByRole('button', { name: '删除分支对话' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '确认删除' }),
    )

    await waitFor(() => {
      expect(mocks.delete).toHaveBeenCalledWith({
        parentChatId,
        branchId,
      })
      expect(mocks.deleted).toHaveBeenCalled()
    })
  })

  it('stops an active branch before closing the panel', async () => {
    mocks.read.mockResolvedValueOnce({
      ok: true,
      data: conversation,
    })

    renderPanel({ kind: 'branch', branchId })
    await screen.findByText('已加载分支聊天')
    fireEvent.click(
      screen.getByRole('button', { name: '关闭分支对话' }),
    )

    await waitFor(() => {
      expect(mocks.stop).toHaveBeenCalled()
      expect(mocks.close).toHaveBeenCalled()
    })
  })
})

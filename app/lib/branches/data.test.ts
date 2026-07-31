import { beforeEach, describe, expect, it, vi } from 'vitest'

type SqlCall = {
  text: string
  values: unknown[]
}

const mocks = vi.hoisted(() => ({
  calls: [] as SqlCall[],
  results: [] as unknown[][],
}))

vi.mock('postgres', () => ({
  default: () => {
    const execute = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      mocks.calls.push({ text, values })
      return mocks.results.shift() ?? []
    }

    return Object.assign(execute, {
      begin: async (callback: (transaction: typeof execute) => unknown) =>
        callback(execute),
    })
  },
}))

vi.mock('@/app/lib/env', () => ({
  env: {
    POSTGRES_URL: 'postgres://test',
  },
}))

import {
  createBranchOnFirstSubmit,
  deleteBranchById,
  findBranchByAnchor,
  getBranchConversation,
} from './data'

const userId = 'adad85e4-e660-4e9b-a7f5-b19848230d33'
const parentChatId = '3d60516d-3443-4faa-862c-6c96f3eafa19'
const anchorMessageId = '535823cd-d4d2-4341-bb7b-37bbef72c1e7'
const branchId = '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4'
const createdAt = new Date('2026-07-29T08:00:00.000Z')

describe('branch data boundaries', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    mocks.results.length = 0
  })

  it('checks for an existing branch without creating an empty branch', async () => {
    mocks.results.push([
      {
        parent_chat_id: parentChatId,
        anchor_message_id: anchorMessageId,
        anchor_content: '这是用于创建分支的完整回答',
        inherited_message_count: 4,
        branch_id: null,
        branch_title: null,
        branch_created_at: null,
      },
    ])

    const lookup = await findBranchByAnchor({
      userId,
      parentChatId,
      anchorMessageId,
    })

    expect(lookup?.branch).toBeNull()
    expect(lookup?.inheritedMessageCount).toBe(4)
    expect(mocks.calls).toHaveLength(1)
    expect(mocks.calls[0].text).not.toContain('INSERT INTO chats')
    expect(mocks.calls[0].text).toContain("anchor.status = 'completed'")
    expect(mocks.calls[0].text).toContain('parent.parent_chat_id IS NULL')
  })

  it('creates a branch only from a completed main-chat assistant anchor', async () => {
    const firstMessage = {
      id: '663749b6-d80e-42d7-9bc8-0860453f5444',
      content: '分支中的第一个问题',
    }
    mocks.results.push(
      [
        {
          id: branchId,
          parent_chat_id: parentChatId,
          branch_from_message_id: anchorMessageId,
          title: '分支：完整回答',
          created_at: createdAt,
        },
      ],
      [{ id: firstMessage.id }],
    )

    const branch = await createBranchOnFirstSubmit({
      userId,
      parentChatId,
      anchorMessageId,
      firstMessage,
    })

    expect(branch?.id).toBe(branchId)
    expect(mocks.calls[0].text).toContain('INSERT INTO chats')
    expect(mocks.calls[0].text).toContain(
      'ON CONFLICT (branch_from_message_id) DO UPDATE',
    )
    expect(mocks.calls[0].text).toContain("anchor.role = 'assistant'")
    expect(mocks.calls[0].text).toContain("anchor.status = 'completed'")
    expect(mocks.calls[1].text).toContain('INSERT INTO messages')
    expect(mocks.calls[1].values).toContain(firstMessage.id)
  })

  it('returns inherited and branch messages as isolated arrays', async () => {
    mocks.results.push(
      [
        {
          id: branchId,
          parent_chat_id: parentChatId,
          branch_from_message_id: anchorMessageId,
          title: '分支：完整回答',
          created_at: createdAt,
          anchor_id: anchorMessageId,
          anchor_role: 'assistant',
          anchor_content: '锚点回答',
          anchor_status: 'completed',
          anchor_created_at: createdAt,
        },
      ],
      [
        {
          id: '065c30b8-a52a-48e1-87bd-b1e2801a88f9',
          role: 'user',
          content: '主对话问题',
          status: 'completed',
          created_at: new Date('2026-07-29T07:59:00.000Z'),
        },
        {
          id: anchorMessageId,
          role: 'assistant',
          content: '锚点回答',
          status: 'completed',
          created_at: createdAt,
        },
      ],
      [
        {
          id: '663749b6-d80e-42d7-9bc8-0860453f5444',
          role: 'user',
          content: '分支问题',
          status: 'completed',
          created_at: new Date('2026-07-29T08:01:00.000Z'),
        },
      ],
    )

    const conversation = await getBranchConversation({
      userId,
      parentChatId,
      branchId,
    })

    expect(conversation?.inheritedMessages).toHaveLength(2)
    expect(conversation?.inheritedMessages[1].id).toBe(anchorMessageId)
    expect(conversation?.branchMessages).toHaveLength(1)
    expect(conversation?.branchMessages[0].id).not.toBe(anchorMessageId)

    const inheritedQuery = mocks.calls[1].text
    expect(inheritedQuery).toContain(
      'message.created_at < anchor.created_at',
    )
    expect(inheritedQuery).toContain(
      'branch.branch_from_message_id',
    )

    const branchMessagesQuery = mocks.calls[2].text
    expect(branchMessagesQuery).toContain('branch.id = message.chat_id')
    expect(branchMessagesQuery).toContain(
      'branch.parent_chat_id =',
    )
  })

  it('deletes only a branch that belongs to the requested main chat', async () => {
    mocks.results.push([{ id: branchId }])

    const deleted = await deleteBranchById({
      userId,
      parentChatId,
      branchId,
    })

    expect(deleted).toBe(true)
    expect(mocks.calls[0].text).toContain(
      'branch.parent_chat_id = parent.id',
    )
    expect(mocks.calls[0].text).toContain('parent.parent_chat_id IS NULL')
  })
})

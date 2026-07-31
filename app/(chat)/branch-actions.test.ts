import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('@/app/lib/auth/require-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'adad85e4-e660-4e9b-a7f5-b19848230d33',
  })),
}))

vi.mock('@/app/lib/ai/provider', () => ({
  modelIds: ['deepseek-chat', 'deepseek-reasoner'] as const,
}))

vi.mock('@/app/lib/branches/data', () => ({
  findBranchByAnchor: mocks.find,
  createBranchOnFirstSubmit: mocks.create,
  getBranchConversation: mocks.read,
  deleteBranchById: mocks.remove,
}))

import {
  createBranchOnFirstSubmit,
  findBranchByAnchor,
} from './branch-actions'

const input = {
  parentChatId: '3d60516d-3443-4faa-862c-6c96f3eafa19',
  anchorMessageId: '535823cd-d4d2-4341-bb7b-37bbef72c1e7',
}
const firstSubmitInput = {
  ...input,
  firstMessage: {
    id: '663749b6-d80e-42d7-9bc8-0860453f5444',
    content: '请解释这部分内容',
  },
}

describe('branch actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not call the create path when the user only opens a draft', async () => {
    mocks.find.mockResolvedValueOnce({
      parentChatId: input.parentChatId,
      anchorMessageId: input.anchorMessageId,
      anchorPreview: '锚点摘要',
      inheritedMessageCount: 4,
      branch: null,
    })

    const result = await findBranchByAnchor(input)

    expect(result.ok).toBe(true)
    expect(mocks.find).toHaveBeenCalledOnce()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates the branch only through the explicit first-submit action', async () => {
    mocks.create.mockResolvedValueOnce({
      id: '8d0ca8bc-02b7-4345-9f04-3142a3f29cc4',
      parentChatId: input.parentChatId,
      anchorMessageId: input.anchorMessageId,
      title: '分支：锚点摘要',
      createdAt: '2026-07-29T08:00:00.000Z',
    })

    const result = await createBranchOnFirstSubmit(firstSubmitInput)

    expect(result.ok).toBe(true)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/chat/${input.parentChatId}`,
    )
  })
})

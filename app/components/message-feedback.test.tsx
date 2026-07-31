import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MessageFeedback } from './message-feedback'

const addLikesMock = vi.hoisted(() => vi.fn())

vi.mock('@/app/(chat)/action', () => ({
  addLikes: addLikesMock,
}))

describe('MessageFeedback', () => {
  it('rolls back the optimistic state and displays the server error', async () => {
    let resolveRequest:
      | ((result: {
          ok: false
          error: { code: string; message: string }
        }) => void)
      | undefined
    addLikesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
    )

    render(
      <MessageFeedback
        chatId="3d60516d-3443-4faa-862c-6c96f3eafa19"
        messageId="535823cd-d4d2-4341-bb7b-37bbef72c1e7"
      />,
    )

    const likeButton = screen.getByRole('button', { name: '点赞' })
    fireEvent.click(likeButton)
    expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    await act(async () => {
      resolveRequest?.({
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: '消息不存在',
        },
      })
    })

    expect(likeButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('alert')).toHaveTextContent('消息不存在')
  })
})

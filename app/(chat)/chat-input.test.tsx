import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <div aria-label={alt} />,
}))

vi.mock('../components/model-selector', () => ({
  ModelSelector: () => <div>模型选择器</div>,
}))

import ChatInput from './chat-input'

describe('ChatInput image upload', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uploads the image before submitting one combined chat message', async () => {
    const onSubmit = vi.fn(() => true)
    const uploadFetch = vi.fn().mockResolvedValue(
      Response.json({
        url: 'https://example.public.blob.vercel-storage.com/example.png',
        mediaType: 'image/png',
        filename: 'example.png',
      }),
    )
    vi.stubGlobal('fetch', uploadFetch)

    const { container } = render(
      <ChatInput
        modelId="deepseek-chat"
        onChange={vi.fn()}
        onModelChange={vi.fn()}
        onStop={vi.fn()}
        onSubmit={onSubmit}
        status="ready"
        value="分析这张图片"
      />,
    )
    const file = new File(['image'], 'example.png', {
      type: 'image/png',
    })
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    )!

    fireEvent.change(fileInput, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('分析这张图片', [
        {
          url: 'https://example.public.blob.vercel-storage.com/example.png',
          mediaType: 'image/png',
          filename: 'example.png',
        },
      ])
    })
    expect(uploadFetch).toHaveBeenCalledWith(
      '/api/upload',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps the draft and does not send a message when upload fails', async () => {
    const onSubmit = vi.fn(() => true)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { error: { message: '图片上传失败' } },
          { status: 500 },
        ),
      ),
    )

    const { container } = render(
      <ChatInput
        modelId="deepseek-chat"
        onChange={vi.fn()}
        onModelChange={vi.fn()}
        onStop={vi.fn()}
        onSubmit={onSubmit}
        status="ready"
        value="分析这张图片"
      />,
    )
    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      {
        target: {
          files: [
            new File(['image'], 'example.png', { type: 'image/png' }),
          ],
        },
      },
    )
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '图片上传失败',
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

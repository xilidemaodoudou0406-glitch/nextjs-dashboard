import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  requireUser: vi.fn(),
}))

vi.mock('@vercel/blob', () => ({
  put: mocks.put,
}))

vi.mock('@/app/lib/auth/require-user', () => ({
  requireUser: mocks.requireUser,
}))

import { POST } from './route'

function createUploadRequest(file: File) {
  const formData = new FormData()
  formData.append('file', file)

  // jsdom 的 File 与 Node/undici 的 multipart File 构造器不是同一个类；
  // Route Handler 在这里关心的是 formData 解析后的输入，因此直接模拟该边界。
  return {
    formData: async () => formData,
  } as Request
}

describe('POST /api/upload', () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({
      id: 'adad85e4-e660-4e9b-a7f5-b19848230d33',
    })
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test')
    mocks.put.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uploads an authenticated image and returns its public HTTPS URL', async () => {
    mocks.put.mockResolvedValue({
      url: 'https://example.public.blob.vercel-storage.com/example.png',
    })

    const response = await POST(
      createUploadRequest(
        new File(['image'], 'example.png', { type: 'image/png' }),
      ),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://example.public.blob.vercel-storage.com/example.png',
      mediaType: 'image/png',
      filename: 'example.png',
    })
    expect(mocks.requireUser).toHaveBeenCalledOnce()
    expect(mocks.put).toHaveBeenCalledWith(
      'chat-images/example.png',
      expect.any(File),
      { access: 'public', addRandomSuffix: true },
    )
  })

  it('rejects unsupported files before contacting storage', async () => {
    const response = await POST(
      createUploadRequest(
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
      ),
    )

    expect(response.status).toBe(422)
    expect(mocks.put).not.toHaveBeenCalled()
  })
})

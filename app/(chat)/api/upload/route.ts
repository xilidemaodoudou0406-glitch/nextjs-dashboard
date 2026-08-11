import { put } from '@vercel/blob'

import { requireUser } from '@/app/lib/auth/require-user'
import {
  routeErrorResponse,
  validationError,
} from '@/app/lib/errors'

export const runtime = 'nodejs'

const MAX_IMAGE_SIZE = 4 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

/**
 * 把浏览器上传的临时 File 转存到 Vercel Blob，返回模型可以读取的公网 HTTPS URL。
 * Blob 写入令牌只存在于服务端；浏览器始终只访问本项目的 /api/upload。
 */
export async function POST(request: Request) {
  try {
    await requireUser()

    const formData = await request.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) {
      throw validationError('请选择要上传的图片')
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      throw validationError('仅支持 JPEG、PNG、WebP 或 GIF 图片')
    }

    if (file.size === 0 || file.size > MAX_IMAGE_SIZE) {
      throw validationError('图片大小必须在 4MB 以内')
    }

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is missing')
    }

    // 返回一个公网url
    const blob = await put(`chat-images/${file.name}`, file, {
      access: 'public',
      addRandomSuffix: true,
    })

    return Response.json({
      url: blob.url,
      mediaType: file.type,
      filename: file.name,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

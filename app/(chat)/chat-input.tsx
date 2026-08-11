// app/(chat)/chat-input.tsx
// 输入框组件
'use client'

import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import { ModelSelector } from '../components/model-selector'
import {
  isChatRequestInProgress,
  type ChatRuntimeStatus,
} from '@/app/lib/ai/message'

type UploadedFilePart = {
  url: string
  mediaType: string
  filename?: string
}

type PendingAttachment = {
  id: string
  file: File
  previewUrl: string
}

type UploadResponse = UploadedFilePart & {
  error?: { message?: string }
}

interface Props {
  value: string
  onChange: (val: string) => void
  onSubmit: (text: string, fileParts: UploadedFilePart[]) => boolean
  status: ChatRuntimeStatus // 就是指ready / submitted / streaming / error
  onStop: () => void
  modelId: string
  onModelChange: (modelId: string) => void
}

export default function ChatInput({
  value,
  onChange,
  onSubmit,
  status,
  onStop,
  modelId,
  onModelChange,
}: Props) {
  const isStreaming = isChatRequestInProgress(status)
  // 用来存文件的变量。这里保存浏览器 File 和仅供预览使用的 blob URL，
  // 真正发送给模型的是上传接口返回的公网 HTTPS URL。
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]) //  原始 File 对象
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadLockRef = useRef(false)
  const previewUrlsRef = useRef(new Set<string>())

  useEffect(
    () => () => {
      // URL.createObjectURL 会占用浏览器内存，组件卸载时统一释放残留预览。
      for (const previewUrl of previewUrlsRef.current) {
        URL.revokeObjectURL(previewUrl)
      }
      previewUrlsRef.current.clear()
    },
    [],
  )

  const releasePreview = (previewUrl: string) => {
    URL.revokeObjectURL(previewUrl)
    previewUrlsRef.current.delete(previewUrl)
  }

  const clearAttachments = () => {
    for (const attachment of attachments) {
      releasePreview(attachment.previewUrl)
    }
    setAttachments([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? [])
    setUploadError(null)

    // 当前文件选择器只允许一张图；重新选择时释放旧预览。
    for (const attachment of attachments) {
      releasePreview(attachment.previewUrl)
    }

    // URL.createObjectURL(file) 会在浏览器内存中创建临时预览 URL，
    // 它不会暴露硬盘路径，也绝不会被当作模型需要的公网 URL。
    const nextAttachments = files.map((file) => {
      const previewUrl = URL.createObjectURL(file)
      previewUrlsRef.current.add(previewUrl)
      return { id: crypto.randomUUID(), file, previewUrl }
    })
    setAttachments(nextAttachments)
  }

  // 删除已选文件
  const removeFile = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed) releasePreview(removed.previewUrl)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  const uploadImage = async (file: File): Promise<UploadedFilePart> => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    })
    const result = (await response.json()) as UploadResponse

    if (!response.ok || !result.url) {
      throw new Error(result.error?.message ?? '图片上传失败，请重试')
    }

    return {
      url: result.url,
      mediaType: result.mediaType,
      filename: result.filename,
    }
  }

  /**
   * 图片上传和聊天请求是两个阶段：先把 File 换成公网 URL，成功后再把
   * text part 与 file part 组装为同一条用户消息。上传失败时不会发送消息。
   */
  const submitMessage = async () => {
    if (isStreaming || uploadLockRef.current) return
    if (!value.trim() && attachments.length === 0) return

    uploadLockRef.current = true
    setIsUploading(attachments.length > 0)
    setUploadError(null)

    try {
      const fileParts = await Promise.all(
        attachments.map((attachment) => uploadImage(attachment.file)),
      )

      // 上传期间主对话可能从其他入口开始请求；只有真正进入 useChat 的消息
      // 才能清空草稿，避免公网图片已上传但本地输入被误删。
      const wasSubmitted = onSubmit(value, fileParts)
      if (!wasSubmitted) {
        setUploadError('当前对话正在生成，请稍后再次发送')
        return
      }

      onChange('')
      clearAttachments()
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : '图片上传失败，请重试',
      )
    } finally {
      uploadLockRef.current = false
      setIsUploading(false)
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitMessage()
  }

  const isInputBusy = isStreaming || isUploading
  const cannotSend =
    isInputBusy || (!value.trim() && attachments.length === 0)

  return (
    <form className="border-t p-4" onSubmit={handleSubmit}>
      {/* 文件预览区 */}
      {attachments.length > 0 && (
        <div className="flex gap-2 p-2">
          {attachments.map((attachment) => (
            <div className="relative" key={attachment.id}>
              <Image
                alt={attachment.file.name || '待上传图片预览'}
                className="h-16 w-16 rounded object-cover"
                height={64}
                src={attachment.previewUrl}
                unoptimized
                width={64}
              />
              <button
                aria-label={`移除 ${attachment.file.name}`}
                className="absolute -right-1 -top-1 rounded-full bg-red-500 p-0.5 text-white"
                disabled={isInputBusy}
                onClick={() => removeFile(attachment.id)}
                type="button"
              >
                <X aria-hidden="true" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadError && (
        <p className="mx-auto mb-2 max-w-3xl text-sm text-red-600" role="alert">
          {uploadError}
        </p>
      )}

      {/* 模型选择器 */}
      <div className="mx-auto mb-2 max-w-3xl">
        <ModelSelector
          currentModel={modelId}
          onModelChange={onModelChange}
        />
      </div>

      <div className="mx-auto flex max-w-3xl gap-2">
        {/* 隐藏input，通过button进行文件输入 */}
        <input
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />

        {/* 上传按钮 */}
        <button
          aria-label="选择图片"
          className="rounded p-2 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
          disabled={isInputBusy}
          // 调用原生文件选择器
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <ImageIcon aria-hidden="true" size={20} />
        </button>

        <textarea
          className="flex-1 resize-none rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          disabled={isInputBusy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送,Shift+Enter 换行
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submitMessage()
            }
          }}
          placeholder="说点什么..."
          rows={1}
          value={value}
        />

        {isStreaming ? (
          <button
            className="rounded bg-red-500 px-4 py-2 text-white hover:bg-red-600"
            onClick={onStop}
            type="button"
          >
            停止
          </button>
        ) : (
          <button
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={cannotSend}
            type="submit"
          >
            {isUploading ? '上传中...' : '发送'}
          </button>
        )}
      </div>
    </form>
  )
}

// Enter 发送、Shift+Enter 换行（标准聊天框行为）
// 流式输出期间，"发送"按钮变成"停止"
// 空输入且没有图片时禁用发送按钮

// app/(chat)/chat-input.tsx
// 输入框组件
'use client'

import Image from 'next/image'
import { useState, useRef, useEffect } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import { ModelSelector } from '../components/model-selector'
import {
  isChatRequestInProgress,
  type ChatRuntimeStatus,
} from '@/app/lib/ai/message'

interface Props {
  value: string
  onChange: (val: string) => void
  onSubmit: (text: string, fileParts: { url: string; mediaType: string }[]) => void
  status: ChatRuntimeStatus // 就是指ready / submitted / streaming / error
  onStop: () => void
  modelId: string
  onModelChange: (modelId: string) => void
}

export default function ChatInput({ value, onChange, onSubmit, status, onStop, modelId, onModelChange }: Props) {
  const isStreaming = isChatRequestInProgress(status)
  
  // 用来存文件的变量
  const [attachments, setAttachments] = useState<File[]>([])
  // 用于存放URL.createObjectURL(file)生成的URL
  const [previews, setPreviews] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setAttachments(files);
    // 生成预览

    // URL.createObjectURL(file)会在浏览器的内存中为这个 File 对象创建一个伪 URL,
    // 是因为安全限制，不会暴露文件在用户硬盘上的真实路径。
    // 这个 URL 只在当前页面会话有效，关闭标签页或调用 revokeObjectURL 后就失效
    const newPreviews = files.map(file => URL.createObjectURL(file));
    setPreviews(newPreviews);
  };

    // 删除已选文件
  const removeFile = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
    setPreviews(prev => prev.filter((_, i) => i !== index));
  };
    

  // 发送：用已有 previews（blob URL）+ attachments 拼 fileParts
  const submitMessage = () => {
    if (submittingRef.current) return // 防止快速连点/连按 Enter 重复发送
    if (!value.trim() && attachments.length === 0) return;

    submittingRef.current = true

    // previews 已在 handleFileChange 中生成（blob URL），直接用
    const fileParts = attachments.map((file, i) => ({
      url: previews[i],
      mediaType: file.type,
    }));
    onSubmit(value, fileParts);

    // 清空
    onChange('');
    setAttachments([]);
    setPreviews([]);
  };

  // value 被 onChange('') 清空后解锁，允许下一次发送
  useEffect(() => {
    if (!value) {
      submittingRef.current = false
    }
  }, [value])

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submitMessage()
  }


  return (
    <form onSubmit={handleSubmit} className="border-t p-4">
      {/* 文件预览区 */}
      {previews.length > 0 && (
        <div className="flex gap-2 p-2">
          {previews.map((src, i) => (
            <div key={i} className="relative">
              <Image
                src={src}
                width={64}
                height={64}
                unoptimized
                className="h-16 w-16 rounded object-cover"
                alt="preview"
              />
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* 模型选择器 */}
      <div className="max-w-3xl mx-auto mb-2">
        <ModelSelector currentModel={modelId} onModelChange={onModelChange} />
      </div>

      <div className="flex gap-2 max-w-3xl mx-auto">
        {/* 隐藏input，通过button进行文件输入 */}
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept="image/*"
          onChange={handleFileChange}
        />

        {/* 上传按钮 */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
        >
          <ImageIcon size={20} />
        </button>

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送,Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submitMessage()
            }
          }}
          placeholder="说点什么..."
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
        />
        
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            发送
          </button>
        )}
      </div>
    </form>
  )
}

// Enter 发送、Shift+Enter 换行（标准聊天框行为）
// 流式输出期间，"发送"按钮变成"停止"
// 空输入禁用发送按钮

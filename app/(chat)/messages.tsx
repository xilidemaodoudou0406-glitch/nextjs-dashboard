// app/(chat)/messages.tsx
'use client'

import { useEffect, useRef } from 'react'
import type { UIMessage } from 'ai'
import Markdown from './markdown'
import { MessageFeedback } from '@/app/components/message-feedback'

interface Props {
  chatId: string
  messages: UIMessage[]
  status: string
}

export default function Messages({ chatId, messages, status }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  
  // 新消息自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])
  
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        开始你的对话吧
      </div>
    )
  }
  
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[80%] rounded-lg px-4 py-2 ${
              message.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-900'
            }`}
          >
            {message.parts.map((part, idx) => {
            // 每条 message 有 parts 数组（可能包含文本、图片、工具调用等多种 part）。
            // 我们先只处理 text 类型。后面 Phase 6 加图片支持时再扩展

            // 每次 messages 这个数组变化（哪怕只是最后一条消息的 text 字段加了一个字），React 都会：
            // 重新跑这个 map
            // 对比新旧 DOM，发现"哦，最后一个 div 的文本变了"
            // 只更新那一个 DOM 节点
              if (part.type === 'text') {
                if (message.role === 'user') {
                    return <div key={idx} className="whitespace-pre-wrap">{part.text}</div>
                    }
                return <Markdown key={idx}>{part.text}</Markdown>
              }
              return null
            })}
            {message.role === 'assistant' && (
              <div className="mt-2 pt-1 flex items-center">
                <MessageFeedback messageId={message.id} chatId={chatId} />
              </div>
            )}

          </div>
        </div>
      ))}

      
      
      {status === 'submitted' && (
        <div className="flex justify-start">
          <div className="bg-gray-100 rounded-lg px-4 py-2 text-gray-500">
            思考中...
          </div>
        </div>
      )}
      
      <div ref={bottomRef} />
    </div>
  )
}
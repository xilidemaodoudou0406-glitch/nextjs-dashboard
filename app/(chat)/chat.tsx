// app/(chat)/chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState, useMemo } from 'react'
import Messages from './messages'
import ChatInput from './chat-input'

export default function Chat() {
  const [input, setInput] = useState('')
  
  // 为这次会话生成一个固定的 chatId
    // useMemo 配合空依赖数组 []，
    // 让 chatId 只在组件首次挂载时生成一次，之后不变。
    // 这样整个会话期间共享同一个 chatId
  const chatId = useMemo(() => crypto.randomUUID(), [])
  
  const { messages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    transport: new DefaultChatTransport({ 
      api: '/api/chat',
      body: { id: chatId },  // 每次请求自动带上 chatId
    }),
  })
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage({ text: input })
    setInput('')
  }
  
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <Messages messages={messages} status={status} />
      
      {error && (
        <div className="mx-4 mb-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          出错了：{error.message}
        </div>
      )}
      
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        status={status}
        onStop={stop}
      />
    </div>
  )
}
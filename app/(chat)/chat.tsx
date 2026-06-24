// app/(chat)/chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState } from 'react'
import Messages from './messages'
import ChatInput from './chat-input'

export default function Chat() {
  const [input, setInput] = useState('')
  
  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
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
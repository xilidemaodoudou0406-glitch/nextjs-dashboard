// app/(chat)/chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Messages from './messages'
import ChatInput from './chat-input'
import { Suggestions } from '@/app/components/suggestions'

interface Props {
  chatId: string
  initialMessages?: UIMessage[]
}

// 组件不再自己生成 chatId，
// 而是从外部接收——这样 /（首页）和 /chat/[id]（历史页）可以共用同一个组件
export default function Chat({ chatId, initialMessages = [] }: Props) {
  const [input, setInput] = useState('')
  const router = useRouter()
  
  const { messages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    // 这个初始化历史消息每次发消息都会传给后端（前提是触发这个之后）

    // 这里目前先了解这么多 还有usechat内部原理没有了解
    // 后面需要了解这个messages 是怎么被usechat维护的
    // 此处注意对比有初始化历史消息和没有这两种情况下，发送消息的不同
    messages: initialMessages, // 这个是传回来的历史消息
    transport: new DefaultChatTransport({ 
      api: '/api/chat',
      body: { id: chatId },
    }),
    // ai流式响应全部结束的时候触发onfinish
    onFinish:() => {
    // 这里的refresh方法是next特有，该方法单独刷新 Server Components(让侧边栏更新)
    // 因为侧边栏在 layout 里，发消息时不会重新渲染
    // server components和client 的更新机制不同（去了解）
      router.refresh()
    }
  })
  // 此处我有一个疑问：这边是把历史消息和心得消息打包一起发给后端，
  // 如果设计成只发送新消息到后端（不是这个接口，这个接口是掉模型api的）
  // 然后后端在掉数据库 将消息整合到一起，再去访问模型api这两者有何区别？
  
  // 当首次发出消息后,如果当前 URL 不是 /chat/[id],跳转过去


  
  // 此处有疑问
  // 暂时理解为这里是判断在首页的时候用户是否发送了第一条消息，是否要跳转路由
  useEffect(() => {
    if (messages.length === 1 && messages[0].role === 'user') {
      const currentPath = window.location.pathname
      if (currentPath === '/') {
        // 用 replace 不污染历史栈
        
        // replaceState 之后，app/(chat)/chat/[id]/page.tsx 永远不会在执行了，
        // 除非刷新页面或者手动输入地址等
        // 除非用户主动刷新页面或重新打开这个 URL

        // 注意区分 这个是原生方法，只是修改路径而已(并不会跳转路由)
        // 并不会触发初始化历史消息
        window.history.replaceState(null, '', `/chat/${chatId}`)
      }
    }
  }, [messages, chatId])
  
  // 在chat-input中调用这个函数，这个函数更新messages并且调用transport发送请求
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage({ text: input })
    setInput('')
  }
  
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto flex flex-col justify-center p-4">
        {/* chat组件就是右侧聊天区域，要是有消息就不显示建议，即变成对话框，显示消息 */}
        {/* 点击建议按钮时，调用 onSend 函数发送消息，onSend 函数会调用 sendMessage 方法发送消息
        发送消息后，messages 会更新，组件重新渲染，显示消息列表
        发送消息后，onFinish 回调会触发 router.refresh()，刷新侧边栏 */}
        {messages.length === 0 ? (
          <Suggestions onSend={(text) => sendMessage({ text })} />
        ) : (
          <Messages messages={messages} status={status}/>
        )}
      </div>
      
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
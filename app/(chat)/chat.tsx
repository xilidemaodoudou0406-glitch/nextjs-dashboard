// app/(chat)/chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Messages from './messages'
import ChatInput from './chat-input'
import BranchPanel from './branch/branch-panel'
import { Suggestions } from '@/app/components/suggestions'
import {
  getMessagePersistenceStatus,
  type ChatMessage,
  type MessagePersistenceStatus,
} from '@/app/lib/ai/message'

interface Props {
  chatId: string
  initialMessages?: ChatMessage[]
}

// 组件不再自己生成 chatId，
// 而是从外部接收——这样 /（首页）和 /chat/[id]（历史页）可以共用同一个组件
export default function Chat({ chatId, initialMessages = [] }: Props) {

  const [input, setInput] = useState('')
  const [activeBranchAnchor, setActiveBranchAnchor] =
    useState<ChatMessage | null>(null)
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null)
  const router = useRouter()
  const [modelId, setModelId] = useState('deepseek-chat')
  // 记录每条assistant消息的完成状态
  const [livePersistenceStatuses, setLivePersistenceStatuses] = useState<
    Record<string, MessagePersistenceStatus>
  >({})

  const { messages, sendMessage, status, stop, error } = useChat<ChatMessage>({
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
    onFinish:({ message, isAbort, isDisconnect, isError, finishReason }) => {
      if (message.role === 'assistant') {
        // useChat 状态描述“请求进行到哪一步”；这里记录的是
        // “这条消息最终如何结束”。两套状态不能混在一起使用。
        if (isAbort) {
          setLivePersistenceStatuses((current) => ({
            ...current,
            [message.id]: getMessagePersistenceStatus(true),
          }))
        } else if (
          !isDisconnect &&
          !isError &&
          finishReason !== 'error'
        ) {
          setLivePersistenceStatuses((current) => ({
            ...current,
            [message.id]: getMessagePersistenceStatus(false),
          }))
        }
      }

    // 这里的refresh方法是next特有，该方法单独刷新 Server Components(让侧边栏更新)
    // 因为侧边栏在 layout 里，发消息时不会重新渲染
    // server components和client 的更新机制不同（去了解）
      router.refresh()
    }
  })
  // 此处我有一个疑问：这边是把历史消息和新消息打包一起发给后端，

  // 上面那个问题：区别只在谁来拼上下文。你现在是客户端拼，另一种是服务端拼。客户端拼的好处是不用每次额外查一次数据库；服务端拼的好处是客户端传的数据更少、更不容易被篡改上下文。两种都是常见做法。
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
  const handleSubmit = (text: string, fileParts: { url: string; mediaType: string }[]) => {
    if (!text.trim() && fileParts.length === 0) return
    const userMessageId = crypto.randomUUID()

    void sendMessage({
      // AI SDK 的 `id` 用于给一条新消息指定身份；
      // `messageId` 表示“替换已有消息”，传新 UUID 会触发 not found。
      id: userMessageId,
      role: 'user',
      // A2：ID 在发送前生成，useChat、请求体和数据库会沿用同一个值。
      parts: [
        { type: 'text', text },
        ...fileParts.map(f => ({
          type: 'file' as const,
          url: f.url,
          mediaType: f.mediaType,
        })),
      ],
    })
    setInput('')
  }
  // 作用是把是否终断这个状态加到messages这个数组中去，
  // 交给messages组件渲染判断是否渲染点赞和分支功能
  const displayMessages = useMemo<ChatMessage[]>(
    () =>
      messages.map((message) => {
        const persistenceStatus = livePersistenceStatuses[message.id]
        if (!persistenceStatus) return message

        return {
          ...message,
          metadata: {
            ...message.metadata,
            persistenceStatus,
          },
        }
      }),
    [livePersistenceStatuses, messages],
  )

  /**
   * 主对话只保存“当前选中了哪个锚点”，不保存任何分支 messages。
   * 分支的查询、草稿状态和独立 useChat 全部由 BranchPanel 自己管理。
   */
  const openBranch = (
    message: ChatMessage,
    trigger: HTMLButtonElement,
  ) => {
    branchTriggerRef.current = trigger// 记录触发按钮，关闭分支面板时让它重新获得焦点
    setActiveBranchAnchor(message) // 设置当前锚点消息，BranchPanel 会根据这个锚点加载对应分支
  }

  const closeBranch = () => {
    setActiveBranchAnchor(null)
    window.requestAnimationFrame(() => branchTriggerRef.current?.focus())
  }
  
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col justify-center overflow-y-auto p-4">
        {/* chat组件就是右侧聊天区域，要是有消息就不显示建议，即变成对话框，显示消息 */}
        {/* 点击建议按钮时，调用 onSend 函数发送消息，onSend 函数会调用 sendMessage 方法发送消息
        发送消息后，messages 会更新，组件重新渲染，显示消息列表
        发送消息后，onFinish 回调会触发 router.refresh()，刷新侧边栏 */}
        {messages.length === 0 ? (
          <Suggestions onSend={(text) => handleSubmit(text, [])} />
        ) : (
          <Messages
            chatId={chatId}
            messages={displayMessages}
            onOpenBranch={openBranch}
            status={status}
          />
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
          modelId={modelId}
          onModelChange={setModelId}
        />
      </div>

      {activeBranchAnchor && (
        <BranchPanel
          anchorMessage={activeBranchAnchor}
          key={activeBranchAnchor.id}
          modelId={modelId}
          onClose={closeBranch}
          parentChatId={chatId}
        />
      )}
    </div>
  )
}

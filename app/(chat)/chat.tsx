// app/(chat)/chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Messages from './messages'
import ChatInput from './chat-input'
import BranchPanel, {
  type BranchPanelSource,
} from './branch/branch-panel'
import { Suggestions } from '@/app/components/suggestions'
import {
  getUnansweredUserMessage,
  getMessagePersistenceStatus,
  isChatRequestInProgress,
  type ChatMessage,
  type MessagePersistenceStatus,
} from '@/app/lib/ai/message'
import { buildBranchUrl } from '@/app/lib/branches/url'

interface Props {
  chatId: string
  initialMessages?: ChatMessage[]
}

// 组件不再自己生成 chatId，
// 而是从外部接收——这样 /（首页）和 /chat/[id]（历史页）可以共用同一个组件
export default function Chat({ chatId, initialMessages = [] }: Props) {

  const [input, setInput] = useState('')
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const branchIdFromUrl = searchParams.get('branch')
  const [activeBranchAnchor, setActiveBranchAnchor] =
    useState<ChatMessage | null>(null)
  const [localBranchId, setLocalBranchId] = useState<string | null>(null)
  const persistedBranchId = localBranchId ?? branchIdFromUrl
  const activeBranch: BranchPanelSource | null = activeBranchAnchor
    ? { kind: 'anchor', anchorMessage: activeBranchAnchor }
    : persistedBranchId
      ? { kind: 'branch', branchId: persistedBranchId }
      : null
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null)
  const submissionLockRef = useRef(false)
  const pendingFocusAnchorIdRef = useRef<string | null>(null)
  const shouldRestoreBranchFocusRef = useRef(false)
  const [modelId, setModelId] = useState('deepseek-chat')
  // 记录每条assistant消息的完成状态
  const [livePersistenceStatuses, setLivePersistenceStatuses] = useState<
    Record<string, MessagePersistenceStatus>
  >({})

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    clearError,
    regenerate,
  } = useChat<ChatMessage>({
    id: chatId,
    // 这个初始化历史消息每次发消息都会传给后端（前提是触发这个之后）

    // 这里目前先了解这么多 还有usechat内部原理没有了解
    // 后面需要了解这个messages 是怎么被usechat维护的
    // 此处注意对比有初始化历史消息和没有这两种情况下，发送消息的不同
    messages: initialMessages, // 这个是传回来的历史消息
    transport: new DefaultChatTransport({ 
      api: '/api/chat',
      body: { id: chatId, chatMode: 'main' },
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
  const isBusy = isChatRequestInProgress(status)

  // sendMessage 更新 React 状态前存在一个很短的时间窗。锁放在真正的发送入口，
  // 因而输入框、建议词和以后新增的入口都无法在这个时间窗内重复提交。
  useEffect(() => {
    if (!isBusy) submissionLockRef.current = false
  }, [isBusy])
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

  // pushState 本身不会触发 popstate；只有用户按浏览器前进/后退时才清理
  // 本地临时覆盖，让 useSearchParams 中的 URL branchId 重新成为唯一状态来源。
  useEffect(() => {
    const handleHistoryNavigation = () => {
      setActiveBranchAnchor(null)
      setLocalBranchId(null)
    }

    window.addEventListener('popstate', handleHistoryNavigation)
    return () => {
      window.removeEventListener('popstate', handleHistoryNavigation)
    }
  }, [])

  /**
   * 持久化分支关闭时 router.replace 可能重新渲染页面。若在调用 replace 的
   * 同一帧 focus，焦点会随旧 DOM 被替换而丢失；因此等 URL 与本地面板状态都
   * 已经关闭后再恢复。刷新恢复没有旧 ref 时，通过锚点 ID 查找按钮。
   */
  useEffect(() => {
    if (
      activeBranchAnchor ||
      localBranchId ||
      branchIdFromUrl ||
      !shouldRestoreBranchFocusRef.current
    ) {
      return
    }

    const anchorMessageId = pendingFocusAnchorIdRef.current
    const trigger =
      branchTriggerRef.current ??
      (anchorMessageId
        ? document.querySelector<HTMLButtonElement>(
            `[data-branch-anchor-id="${anchorMessageId}"]`,
          )
        : null)
    trigger?.focus()
    shouldRestoreBranchFocusRef.current = false
    pendingFocusAnchorIdRef.current = null
  }, [activeBranchAnchor, branchIdFromUrl, localBranchId])
  
  // 在chat-input中调用这个函数，这个函数更新messages并且调用transport发送请求
  const handleSubmit = (
    text: string,
    fileParts: { url: string; mediaType: string; filename?: string }[],
  ) => {
    if (
      isBusy ||
      submissionLockRef.current ||
      (!text.trim() && fileParts.length === 0)
    ) {
      return false
    }

    submissionLockRef.current = true
    clearError()
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
          filename: f.filename,
        })),
      ],
    })
      .catch(() => undefined)
      .finally(() => {
        submissionLockRef.current = false
      })
    setInput('')
    return true
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
  const unansweredUserMessage = isBusy
    ? null
    : getUnansweredUserMessage(displayMessages)

  /**
   * 主对话和分支都使用 AI SDK 的 regenerate 重试“已经保存但没有回答”的
   * 最后一条用户消息。messageId 保持不变，服务端幂等校验会复用原记录，
   * 不会为了重试再插入一条重复 user 消息。
   */
  const retryLastResponse = () => {
    if (!unansweredUserMessage || isBusy) return

    clearError()
    // 此处为useChat自带重试函数
    void regenerate({ messageId: unansweredUserMessage.id }).catch(
      () => undefined,
    )
  }

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
    setLocalBranchId(null)

    // 从已打开的持久化分支切到另一个锚点时，旧 branchId 已经不能描述
    // 当前面板。先移除它；如果该锚点已有/新建了分支，面板随后再写入新 ID。
    if (branchIdFromUrl) {
      router.replace(
        buildBranchUrl({ pathname, searchParams, branchId: null }),
        { scroll: false },
      )
    }
  }

  const closeBranch = useCallback((anchorMessageId?: string) => {
    shouldRestoreBranchFocusRef.current = true
    pendingFocusAnchorIdRef.current = anchorMessageId ?? null
    setActiveBranchAnchor(null)
    setLocalBranchId(null)
    router.replace(
      buildBranchUrl({
        pathname,
        searchParams: new URLSearchParams(window.location.search),
        branchId: null,
      }),
      { scroll: false },
    )
  }, [pathname, router])

  /**
   * BranchPanel 找到已有分支或首次创建成功后调用。此时数据库已经存在
   * branchId，才把它写入 URL；单纯打开草稿不会污染地址和浏览历史。
   */
  const persistBranchInUrl = useCallback(
    (branchId: string) => {
      // 先用本地 ID 保持同一个 BranchPanel 实例，再异步更新 URL。这样首次
      // 提交生成的 pending message ref 不会因为短暂卸载而丢失。
      setActiveBranchAnchor(null)
      setLocalBranchId(branchId)

      const currentSearchParams = new URLSearchParams(
        window.location.search,
      )
      if (currentSearchParams.get('branch') !== branchId) {
        router.push(
          buildBranchUrl({
            pathname,
            searchParams: currentSearchParams,
            branchId,
          }),
          { scroll: false },
        )
      }
    },
    [pathname, router],
  )

  const handleBranchDeleted = useCallback(() => {
    closeBranch()
    router.refresh()
  }, [closeBranch, router])
  
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
        {/* chat组件就是右侧聊天区域，要是有消息就不显示建议，即变成对话框，显示消息 */}
        {/* 点击建议按钮时，调用 onSend 函数发送消息，onSend 函数会调用 sendMessage 方法发送消息
        发送消息后，messages 会更新，组件重新渲染，显示消息列表
        发送消息后，onFinish 回调会触发 router.refresh()，刷新侧边栏 */}
        {messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <Suggestions onSend={(text) => handleSubmit(text, [])} />
          </div>
        ) : (
          <Messages
            chatId={chatId}
            messages={displayMessages}
            onOpenBranch={openBranch}
            status={status}
          />
        )}
        </div>

        {(error || unansweredUserMessage) && !isBusy && (
          <div
            className="mx-4 mb-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"
            role="alert"
          >
            <p>
              {error
                ? `出错了：${error.message}`
                : '上一条问题尚未获得回答。'}
            </p>
            <div className="mt-2 flex items-center gap-3">
              {unansweredUserMessage && (
                <button
                  className="font-medium underline underline-offset-2"
                  onClick={retryLastResponse}
                  type="button"
                >
                  重新生成回答
                </button>
              )}
              {error && (
                <button
                  className="underline underline-offset-2"
                  onClick={clearError}
                  type="button"
                >
                  关闭错误
                </button>
              )}
            </div>
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

      {activeBranch && (
        <BranchPanel
          modelId={modelId}
          onBranchPersisted={persistBranchInUrl}
          onClose={closeBranch}
          onDeleted={handleBranchDeleted}
          parentChatId={chatId}
          source={activeBranch}
        />
      )}
    </div>
  )
}

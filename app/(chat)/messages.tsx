// app/(chat)/messages.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WheelEvent } from 'react'
import { GitBranch } from 'lucide-react'
import Markdown from './markdown'
import { MessageFeedback } from '@/app/components/message-feedback'
import { isMessageStableForActions } from '@/app/lib/ai/message'
import type {
  ChatMessage,
  ChatRuntimeStatus,
} from '@/app/lib/ai/message'

interface Props {
  chatId: string
  messages: ChatMessage[]
  status: ChatRuntimeStatus
  emptyLabel?: string
  onOpenBranch?: (
    message: ChatMessage,
    trigger: HTMLButtonElement,
  ) => void
}

export default function Messages({
  chatId,
  messages,
  status,
  emptyLabel = '开始你的对话吧',
  onOpenBranch,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true) // 决定是否滚动
  const userPausedAutoScrollRef = useRef(false)// 用户主动暂停跟随
  const hasDownwardWheelIntentRef = useRef(false)// 是否出现向下滚轮动作
  const [isNearBottom, setIsNearBottom] = useState(true)

  // 作为依赖，加usecallback
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const container = scrollContainerRef.current
      if (!container) return
      // 防御性编程：前面一个if代表现代浏览器（一般就是命中此if）
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior })
      } else {
        // 兼容旧浏览器，直接滚动到底部 bottomRef 用来兜底
        bottomRef.current?.scrollIntoView({ behavior })
      }

      userPausedAutoScrollRef.current = false
      hasDownwardWheelIntentRef.current = false
      isNearBottomRef.current = true
      setIsNearBottom(true) // 点击回到底部又继续开启自动跟随状态
    },
    [],
  )

  const handleScroll = () => {
    const container = scrollContainerRef.current
    if (!container) return

    const distanceFromBottom =
      container.scrollHeight -
        container.scrollTop -
        container.clientHeight

    // 暂停后，单纯靠近底部不能恢复跟随；必须先出现一次向下滚轮动作。
    if (userPausedAutoScrollRef.current) {
      const shouldResume =
        hasDownwardWheelIntentRef.current && distanceFromBottom <= 80
      // 一次向下滚轮动作只参与紧随其后的这次位置判断，避免旧意图残留。
      hasDownwardWheelIntentRef.current = false
      // 锁在这边提前return ，使isNearBottomRef无法更新为true
      if (!shouldResume) {
        isNearBottomRef.current = false
        setIsNearBottom(false)
        return
      }

      userPausedAutoScrollRef.current = false
    }

    // 非主动暂停状态下保留少量像素误差，避免布局小数导致底部误判。
    const nextIsNearBottom = distanceFromBottom <= 80

    isNearBottomRef.current = nextIsNearBottom
    setIsNearBottom(nextIsNearBottom)
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current
    if (!container || event.deltaY === 0) return

    if (event.deltaY > 0) {
      hasDownwardWheelIntentRef.current = true

      // wheel 发生在浏览器更新 scrollTop 之前；如果此刻已经在底部 80px 内，
      // 可以立刻恢复。否则交给随后触发的 scroll 使用更新后的位置判断。
      const distanceFromBottom =
        container.scrollHeight -
        container.scrollTop -
        container.clientHeight

      if (
        userPausedAutoScrollRef.current &&
        distanceFromBottom <= 80
      ) {
        userPausedAutoScrollRef.current = false
        hasDownwardWheelIntentRef.current = false
        isNearBottomRef.current = true
        setIsNearBottom(true)
      }

      return
    }

    // wheel 比 scroll 更早表达用户意图：滚轮刚向上就立刻停止流式自动跟随，
    // 避免下一个 token 到达时把尚未离开底部阈值的用户重新拉回去。
    hasDownwardWheelIntentRef.current = false
    userPausedAutoScrollRef.current = true
    isNearBottomRef.current = false
    setIsNearBottom(false)
  }
  
  // 新消息自动滚动到底部，但不能打断用户主动向上阅读历史。
  // 流式阶段使用 auto，避免每个 token 都启动一次平滑滚动动画。
  useEffect(() => {
    if (!isNearBottomRef.current) return
    scrollToBottom(status === 'streaming' ? 'auto' : 'smooth')
  }, [messages, scrollToBottom, status])
  
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        {emptyLabel}
      </div>
    )
  }
  
  return (
    <div className="relative min-h-0 flex-1">
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="h-full overflow-y-auto px-4 py-6 space-y-4"
        onScroll={handleScroll}
        onWheelCapture={handleWheel}
        ref={scrollContainerRef}
        role="log"
      >
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

            // 这里的messages已经是一个响应式的值，useState在useChat内部
              if (part.type === 'text') {
                if (message.role === 'user') {
                    return <div key={idx} className="whitespace-pre-wrap">{part.text}</div>
                    }
                return <Markdown key={idx}>{part.text}</Markdown>
              }
              return null
            })}
            {/* 只有ai完成回复的才显示点赞和分支 */}
            {isMessageStableForActions(message) && (
              <div className="mt-2 flex items-center gap-1 border-t border-gray-200 pt-2">
                <MessageFeedback messageId={message.id} chatId={chatId} />
                {onOpenBranch && (
                  <button
                    aria-label="基于这条回答打开分支"
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 transition hover:bg-white hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    data-branch-anchor-id={message.id}
                    onClick={(event) =>
                      onOpenBranch(message, event.currentTarget)
                    }
                    type="button"
                  >
                    <GitBranch aria-hidden="true" size={14} />
                    分支
                  </button>
                )}
              </div>
            )}
            {message.role === 'assistant' &&
              message.metadata?.persistenceStatus === 'interrupted' && (
                <p className="mt-2 text-xs text-gray-500">
                  已停止生成
                </p>
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

      {!isNearBottom && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 shadow-md transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          onClick={() => scrollToBottom('smooth')}
          type="button"
        >
          回到底部
        </button>
      )}
    </div>
  )
}

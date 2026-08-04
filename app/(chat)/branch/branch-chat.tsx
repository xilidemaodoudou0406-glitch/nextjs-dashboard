'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import Messages from '../messages'
import BranchComposer from './branch-composer'
import {
  getUnansweredUserMessage,
  getMessagePersistenceStatus,
  isChatRequestInProgress,
  type ChatMessage,
  type MessagePersistenceStatus,
} from '@/app/lib/ai/message'
import {
  buildBranchInitialMessages,
  getVisibleBranchMessages,
} from '@/app/lib/branches/messages'
import type {
  BranchConversation,
  BranchFirstMessage,
} from '@/app/lib/branches/types'

interface Props {
  conversation: BranchConversation
  modelId: string
  onBusyChange?: (isBusy: boolean) => void
  pendingFirstMessage?: BranchFirstMessage
}

export interface BranchChatHandle {
  isBusy: () => boolean
  stopGeneration: () => Promise<void>
}

/**
 * 持久化分支自己的聊天运行时。
 *
 * 这个组件拥有独立于主对话的 useChat。内部 messages 包含继承前缀，
 * 用于维持本地聊天快照；网络只发送最新问题，模型上下文由服务端重建。
 * 传给 Messages 的只有分支自身消息，所以主对话历史不会在右侧面板重复显示。
 */

// 历史消息通过查数据库，最新消息是直接跨组件获取的
const BranchChat = forwardRef<BranchChatHandle, Props>(function BranchChat(
  { conversation, modelId, onBusyChange, pendingFirstMessage },
  ref,
) {
  const inheritedMessageCount = conversation.inheritedMessages.length
  const [input, setInput] = useState('')
  const [livePersistenceStatuses, setLivePersistenceStatuses] = useState<
    Record<string, MessagePersistenceStatus>
  >({})
  const pendingMessageSentRef = useRef(false)

  // useChat 只在该 BranchChat 实例创建时读取初始化消息，因此保留一个稳定快照。
  // 这里把历史主对话消息和分支消息合并
  // 这里的buildBranchInitialMessages返回的是去掉了首条消息的数组，避免重复添加
  const [initialMessages] = useState<ChatMessage[]>(() =>
    buildBranchInitialMessages(conversation, pendingFirstMessage),
  )
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: '/api/chat',
        body: {
          id: conversation.branch.id,
          chatMode: 'branch',
          modelId,
        },
        /**
         * 分支历史不再由浏览器作为权威上下文上传。useChat 本地仍保留完整数组
         * 用于渲染，但网络请求只携带最新用户消息；服务端会根据 branchId 从
         * 数据库重新组装继承前缀和分支历史。
         */
        prepareSendMessagesRequest: ({ body, messages }) => ({
          body: {
            ...body,
            messages: messages.slice(-1),
          },
        }),
      }),
    [conversation.branch.id, modelId],
  )

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    clearError,
    regenerate,
  } = useChat<ChatMessage>({
    id: conversation.branch.id,
    messages: initialMessages,
    transport,
    onFinish: ({
      message,
      isAbort,
      isDisconnect,
      isError,
      finishReason,
    }) => {
      if (message.role !== 'assistant') return

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
    },
  })

  /**
   * 分支中所有普通追问都经过这个入口。
   * 消息 ID 在浏览器中生成，并由 useChat、Route Handler 和数据库共同复用。
   */
  const submitBranchMessage = (content: string) => {
    if (isChatRequestInProgress(status)) return

    clearError()
    setInput('')
    void sendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: content }],
    }).catch(() => undefined)
  }

  useEffect(() => {
    if (!pendingFirstMessage || pendingMessageSentRef.current) return

    // 创建事务已经保存了首条消息；这里复用同一个 ID，只负责触发 AI 流。
    // Route Handler 会把这次重复写入识别为合法的幂等续接。
    pendingMessageSentRef.current = true
    void sendMessage({
      // 对新消息必须传 `id`；AI SDK 的 `messageId` 参数用于替换已有消息。
      id: pendingFirstMessage.id,
      role: 'user',
      parts: [{ type: 'text', text: pendingFirstMessage.content }],
    }).catch(() => undefined)
  }, [pendingFirstMessage, sendMessage])

  const displayMessages = useMemo<ChatMessage[]>(
    () =>
      messages.map((message) => {
        const persistenceStatus =
          livePersistenceStatuses[message.id]
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
  const visibleMessages = getVisibleBranchMessages(
    displayMessages,
    inheritedMessageCount,
  )
  const isBusy = isChatRequestInProgress(status)
  const unansweredUserMessage = isBusy
    ? null
    : getUnansweredUserMessage(visibleMessages)

  useEffect(() => {
    onBusyChange?.(isBusy)
    return () => onBusyChange?.(false)
  }, [isBusy, onBusyChange])

  /**
   * 面板关闭前需要先停止仍在生成的分支，避免组件卸载后请求继续隐藏运行。
   * ref 只暴露“是否忙碌”和“停止”两个生命周期能力，不把 messages 状态提升
   * 到主对话，从而继续保持主线与分支的运行时隔离。
   */
  useImperativeHandle(
    ref,
    () => ({
      isBusy: () => isBusy,
      stopGeneration: async () => {
        if (isBusy) await stop()
      },
    }),
    [isBusy, stop],
  )

  const retryLastResponse = () => {
    if (!unansweredUserMessage || isBusy) return

    clearError()
    void regenerate({ messageId: unansweredUserMessage.id }).catch(
      () => undefined,
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <Messages
          chatId={conversation.branch.id}
          emptyLabel="在下方输入问题，开始这条分支"
          messages={visibleMessages}
          status={status}
        />
      </div>

      {(error || unansweredUserMessage) && !isBusy && (
        <div
          className="mx-3 mb-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          role="alert"
        >
          <p>
            {error
              ? `分支回答失败：${error.message}`
              : '上一条分支问题尚未获得回答。'}
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

      <BranchComposer
        autoFocus={!pendingFirstMessage}
        isBusy={isBusy}
        onChange={setInput}
        onStop={() => {
          void stop()
        }}
        onSubmit={submitBranchMessage}
        value={input}
      />
    </div>
  )
})

BranchChat.displayName = 'BranchChat'

export default BranchChat

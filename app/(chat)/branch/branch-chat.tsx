'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'

import Messages from '../messages'
import BranchComposer from './branch-composer'
import {
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
  pendingFirstMessage?: BranchFirstMessage
}

/**
 * 持久化分支自己的聊天运行时。
 *
 * 这个组件拥有独立于主对话的 useChat。内部 messages 包含继承前缀，
 * 用于向模型提供上下文；传给 Messages 的则只有分支自身消息，所以主对话
 * 历史不会在右侧面板重复显示。
 */
export default function BranchChat({
  conversation,
  modelId,
  pendingFirstMessage,
}: Props) {
  const inheritedMessageCount = conversation.inheritedMessages.length
  const [input, setInput] = useState('')
  const [livePersistenceStatuses, setLivePersistenceStatuses] = useState<
    Record<string, MessagePersistenceStatus>
  >({})
  const pendingMessageSentRef = useRef(false)

  // useChat 只在该 BranchChat 实例创建时读取初始化消息，因此保留一个稳定快照。
  const [initialMessages] = useState<ChatMessage[]>(() =>
    buildBranchInitialMessages(conversation, pendingFirstMessage),
  )
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: {
          id: conversation.branch.id,
          modelId,
        },
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

      {error && (
        <div
          className="mx-3 mb-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          role="alert"
        >
          <div className="flex items-start justify-between gap-3">
            <span>分支回答失败：{error.message}</span>
            <button
              className="shrink-0 underline underline-offset-2"
              onClick={clearError}
              type="button"
            >
              关闭
            </button>
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
}

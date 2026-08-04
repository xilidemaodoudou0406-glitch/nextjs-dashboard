import type { ChatStatus, UIMessage } from 'ai'

/**
 * 一次请求在浏览器中的瞬时状态，由 AI SDK 的 useChat 管理。
 * 它只控制当前界面行为，不写入数据库。
 */
export type ChatRuntimeStatus = ChatStatus

/**
 * 一条 assistant 消息结束后的持久化结果。
 * 它描述消息本身，不能与 useChat 的请求状态混用。
 */
export const messagePersistenceStatuses = [
  'completed',
  'interrupted',
] as const

export type MessagePersistenceStatus =
  (typeof messagePersistenceStatuses)[number]

export interface ChatMessageMetadata {
  persistenceStatus: MessagePersistenceStatus
}

export type ChatMessage = UIMessage<ChatMessageMetadata>

export function isChatRequestInProgress(status: ChatRuntimeStatus): boolean {
  return status === 'submitted' || status === 'streaming'
}

export function getMessagePersistenceStatus(
  wasInterrupted: boolean,
): MessagePersistenceStatus {
  return wasInterrupted ? 'interrupted' : 'completed'
}

export function getMessageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
}

/**
 * 点赞和未来的分支入口都只能操作已完整落库的 assistant 消息。
 * 把规则集中在这里，避免不同按钮各自判断后产生不一致。
 */
export function isMessageStableForActions(message: ChatMessage): boolean {
  // 必须是ai回复且必须完成落库(即不是流式中或被中断的)
  return (
    message.role === 'assistant' &&
    message.metadata?.persistenceStatus === 'completed'
  )
}

/**
 * 找出一条已经进入聊天记录、但后面还没有 assistant 回答的用户消息。
 *
 * 正常发送期间消息列表也会暂时以 user 结尾，因此调用方还需要结合
 * useChat 的运行状态判断：只有请求已经回到 ready/error 时才显示重试。
 * 主对话和分支共用这条判断，避免形成两套不一致的异常恢复规则。
 */
export function getUnansweredUserMessage(
  messages: ChatMessage[],
): ChatMessage | null {
  const lastMessage = messages.at(-1)
  return lastMessage?.role === 'user' ? lastMessage : null
}

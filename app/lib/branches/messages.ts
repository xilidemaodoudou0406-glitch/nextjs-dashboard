import type { ChatMessage } from '@/app/lib/ai/message'
import type {
  BranchConversation,
  BranchFirstMessage,
} from '@/app/lib/branches/types'

/**
 * 为分支 useChat 组装初始化消息。
 *
 * 已有分支直接使用“继承前缀 + 分支历史”。首次创建时，首条用户消息已经
 * 在数据库事务中保存，但还需要由 useChat 主动发送来触发 AI；因此先从
 * 初始化数组中移除这条消息，随后再用同一个 ID 调用 sendMessage，避免 UI
 * 中出现两条相同的用户消息。
 */
export function buildBranchInitialMessages(
  conversation: BranchConversation,
  pendingFirstMessage?: BranchFirstMessage,
): ChatMessage[] {
  const messages = [
    ...conversation.inheritedMessages,
    ...conversation.branchMessages,
  ]

  if (!pendingFirstMessage) return messages

  return messages.filter(
    (message) => message.id !== pendingFirstMessage.id,
  )
}

/**
 * 从分支 useChat 的完整上下文中截取真正应该显示在面板里的消息。
 *
 * 继承前缀始终位于数组开头，只供模型理解主对话语境；分支面板从固定的
 * inheritedMessageCount 之后开始渲染，因此不会把主对话历史重复展示出来。
 */
export function getVisibleBranchMessages(
  messages: ChatMessage[],
  inheritedMessageCount: number,
): ChatMessage[] {
  return messages.slice(inheritedMessageCount)
}

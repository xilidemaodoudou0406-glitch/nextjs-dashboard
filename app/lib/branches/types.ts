import type { ChatMessage } from '@/app/lib/ai/message'

export type BranchSummary = {
  id: string
  parentChatId: string
  anchorMessageId: string
  title: string
  createdAt: string
}

export type BranchFirstMessage = {
  id: string
  content: string
}

/**
 * 点击分支入口时的只读结果。
 * branch 为 null 代表锚点合法但还没有分支，前端应打开临时草稿面板，
 * 而不是立即在数据库里创建空分支。
 */
export type BranchAnchorLookup = {
  parentChatId: string
  anchorMessageId: string
  anchorPreview: string
  inheritedMessageCount: number
  branch: BranchSummary | null
}

/**
 * 继承前缀和分支自身消息必须保持为两个数组：
 * 前者只参与模型上下文，后者才是分支面板需要展示的内容。
 */
export type BranchConversation = {
  branch: BranchSummary
  anchorMessage: ChatMessage
  inheritedMessages: ChatMessage[]
  branchMessages: ChatMessage[]
}

// app/(chat)/chat/[id]/page.tsx
import { notFound } from 'next/navigation'
import Chat from '../../chat'
import { sql } from '@/app/lib/db/client'
import { requireUser } from '@/app/lib/auth/require-user'
import { chatIdSchema } from '@/app/lib/validation/request'
import type {
  ChatMessage,
  MessagePersistenceStatus,
} from '@/app/lib/ai/message'

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireUser({ redirectTo: '/login' })

  // Next.js 15 的 params 是 Promise——必须 await 才能拿到值
  const { id } = await params
  const parsedChatId = chatIdSchema.safeParse(id)
  if (!parsedChatId.success) notFound()
  const chatId = parsedChatId.data
  
  // 验证 chat 归属
  // 拿到对应chatid的chat
  const chats = await sql<{ id: string }[]>`
    SELECT id
    FROM chats
    WHERE id = ${chatId}
      AND user_id = ${user.id}
      -- /chat/[id] 表示主对话；分支以后通过右侧面板和查询参数加载。
      AND parent_chat_id IS NULL
  `
  // notFound为nextjs内置函数
  if (chats.length === 0) notFound()
  
  // 加载历史消息
  // （这段代码只在挂载时执行一次，目的是初始化历史消息，并不是每次发消息都执行）
  const messages = await sql<
    {
      id: string
      role: 'user' | 'assistant'
      content: string
      status: MessagePersistenceStatus
      created_at: Date
    }[]
  >`
    SELECT
      message.id,
      message.role,
      message.content,
      message.status,
      message.created_at
    FROM messages AS message
    INNER JOIN chats AS chat ON chat.id = message.chat_id
    WHERE message.chat_id = ${chatId}
      AND chat.user_id = ${user.id}
      AND chat.parent_chat_id IS NULL
    ORDER BY message.created_at ASC
  `
  
  // 转换成 UIMessage 格式
  const initialMessages: ChatMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    metadata: {
      persistenceStatus: m.status,
    },
    parts: [{ type: 'text' as const, text: m.content }],
  }))
  
  return <Chat key={chatId} chatId={chatId} initialMessages={initialMessages} />
}

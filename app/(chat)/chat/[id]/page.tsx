// app/(chat)/chat/[id]/page.tsx
import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import postgres from 'postgres'
import Chat from '../../chat'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  // Next.js 15 的 params 是 Promise——必须 await 才能拿到值
  const { id: chatId } = await params
  
  // 验证 chat 归属
  // 拿到对应chatid的chat
  const chats = await sql`
    SELECT id, user_id FROM chats WHERE id = ${chatId}
  `
  // notFound为nextjs内置函数
  if (chats.length === 0) notFound()
  if (chats[0].user_id !== session.user.id) notFound()
  
  // 加载历史消息
  // （这段代码只在挂载时执行一次，目的是初始化历史消息，并不是每次发消息都执行）
  const messages = await sql`
    SELECT id, role, content, created_at 
    FROM messages 
    WHERE chat_id = ${chatId}
    ORDER BY created_at ASC
  `
  
  // 转换成 UIMessage 格式
  const initialMessages = messages.map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    parts: [{ type: 'text' as const, text: m.content }],
  }))
  
  return <Chat chatId={chatId} initialMessages={initialMessages} />
}
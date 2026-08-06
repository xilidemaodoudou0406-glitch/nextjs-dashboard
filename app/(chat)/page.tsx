// app/(chat)/page.tsx
import { requireUser } from '@/app/lib/auth/require-user'
import Chat from './chat'

export default async function ChatHomePage() {
  await requireUser({ redirectTo: '/login' })
  
  // 先生成稳定 chatId；真正发送第一条消息时才创建数据库对话。
  const newChatId = crypto.randomUUID()
  
  return <Chat key={newChatId} chatId={newChatId} />
}

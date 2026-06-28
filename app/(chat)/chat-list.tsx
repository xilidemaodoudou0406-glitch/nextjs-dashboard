// app/(chat)/chat-list.tsx
import postgres from 'postgres'
import ChatListClient from './chat-list-client'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

export interface ChatItem {
  id: string
  title: string
  created_at: Date
}

export default async function ChatList({ userId }: { userId: string }) {
  const chats = await sql<ChatItem[]>`
    SELECT id, title, created_at 
    FROM chats 
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `
  
  // 按时间分组
  const grouped = groupChatsByDate(chats)
  // 这里的client表示一个日期内的对话，比如今天所有的对话都在一个client中表示
  return <ChatListClient grouped={grouped} />
}

function groupChatsByDate(chats: ChatItem[]) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
  
  const groups: Record<string, ChatItem[]> = {
    今天: [],
    昨天: [],
    最近七天: [],
    最近三十天: [],
    更早: [],
  }
  
  for (const chat of chats) {
    const date = new Date(chat.created_at)
    if (date >= today) groups['今天'].push(chat)
    else if (date >= yesterday) groups['昨天'].push(chat)
    else if (date >= sevenDaysAgo) groups['最近七天'].push(chat)
    else if (date >= thirtyDaysAgo) groups['最近三十天'].push(chat)
    else groups['更早'].push(chat)
  }
  
  return groups
}
// app/lib/data.ts
// 写查询函数
import postgres from 'postgres'
import { env } from '@/app/lib/env'

const sql = postgres(env.POSTGRES_URL, { ssl: 'require' })

// 取某用户的所有对话（按时间倒序）
export async function fetchChatsByUserId(userId: string) {
  try {
    const chats = await sql`
      SELECT id, title, created_at 
      FROM chats 
      WHERE user_id = ${userId}
        -- 左侧历史列表只属于主对话，分支将在右侧面板中恢复。
        AND parent_chat_id IS NULL
      ORDER BY created_at DESC
    `
    return chats
  } catch (error) {
    console.error('Database Error:', error)
    throw new Error('Failed to fetch chats.')
  }
}

// 取某对话的所有消息
export async function fetchMessagesByChatId(chatId: string, userId: string) {
  try {
    const messages = await sql`
      SELECT message.id, message.role, message.content, message.created_at
      FROM messages AS message
      INNER JOIN chats AS chat ON chat.id = message.chat_id
      WHERE message.chat_id = ${chatId}
        AND chat.user_id = ${userId}
        AND chat.parent_chat_id IS NULL
      ORDER BY message.created_at ASC
    `
    return messages
  } catch (error) {
    console.error('Database Error:', error)
    throw new Error('Failed to fetch messages.')
  }
}

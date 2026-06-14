// app/lib/data.ts
// 写查询函数
import postgres from 'postgres'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

// 取某用户的所有对话（按时间倒序）
export async function fetchChatsByUserId(userId: string) {
  try {
    const chats = await sql`
      SELECT id, title, created_at 
      FROM chats 
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `
    return chats
  } catch (error) {
    console.error('Database Error:', error)
    throw new Error('Failed to fetch chats.')
  }
}

// 取某对话的所有消息
export async function fetchMessagesByChatId(chatId: string) {
  try {
    const messages = await sql`
      SELECT id, role, content, created_at
      FROM messages
      WHERE chat_id = ${chatId}
      ORDER BY created_at ASC
    `
    return messages
  } catch (error) {
    console.error('Database Error:', error)
    throw new Error('Failed to fetch messages.')
  }
}
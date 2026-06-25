// app/(chat)/api/chat/route.ts
import { streamText, type UIMessage, convertToModelMessages } from 'ai'
import { chatModel } from '@/app/lib/ai/provider'
import { auth } from '@/auth'
import postgres from 'postgres'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

export async function POST(req: Request) {
  // 1. 认证
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }
  
  const userId = session.user.id
  
  // 2. 解析请求
  const { messages, id: chatId }: { 
    messages: UIMessage[]
    id: string 
  } = await req.json()
  
  // 3. 取最后一条用户消息
  const lastMessage = messages[messages.length - 1]
  if (lastMessage.role !== 'user') {
    return new Response('Last message must be from user', { status: 400 })
  }
  
  // 4. 确保 chat 存在（不存在就创建）
  const existingChat = await sql`SELECT id FROM chats WHERE id = ${chatId}`
  if (existingChat.length === 0) {
    // 用第一条消息生成标题（取前 30 字符）
    const firstText = lastMessage.parts.find(p => p.type === 'text')
    const title = firstText?.type === 'text' 
      ? firstText.text.slice(0, 30) 
      : '新对话'
    
    await sql`
      INSERT INTO chats (id, user_id, title) 
      VALUES (${chatId}, ${userId}, ${title})
    `
  }
  
  // 5. 存用户消息
  const userText = lastMessage.parts
    .filter(p => p.type === 'text')
    .map(p => (p as any).text)
    .join('')
  
  await sql`
    INSERT INTO messages (chat_id, role, content) 
    VALUES (${chatId}, 'user', ${userText})
  `
  
  // 6. 调用 AI
  const result = streamText({
    model: chatModel,
    system: '你是一个有帮助的 AI 助手。用中文回复。回复要简洁。',
    messages: await convertToModelMessages(messages),
    // AI 回复完成后存数据库
    onFinish: async ({ text }) => {
      await sql`
        INSERT INTO messages (chat_id, role, content) 
        VALUES (${chatId}, 'assistant', ${text})
      `
    },
  })
  
  return result.toUIMessageStreamResponse()
}

// streamText 是 AI SDK 的核心函数，返回一个流式响应
// system：系统提示词，控制 AI 的行为风格
// convertToModelMessages 把前端的 UIMessage 格式转成模型能理解的格式
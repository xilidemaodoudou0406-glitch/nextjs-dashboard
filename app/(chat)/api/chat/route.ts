// app/(chat)/api/chat/route.ts
import { streamText, generateText, type UIMessage, convertToModelMessages } from 'ai'
import { models } from '@/app/lib/ai/provider'
import { auth } from '@/auth'
import postgres from 'postgres'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

// ai生成标题函数
async function generateTitle(firstMessage:string):Promise<string> {
  // 根据用户输入的第一句话生成
  try {
    const { text } = await generateText({
      model: models['deepseek-chat'],
      system: '你是一个标题生成助手。根据用户的第一条消息生成一个简短的对话标题(不超过 15 字)。直接返回标题文字,不要任何引号、标点或解释。',
      prompt: firstMessage,
      maxOutputTokens: 50,
    })
    return text.trim().slice(0, 30)  // 截断防御
  } catch (error) {
    console.log(error)
    return firstMessage.slice(0,30)
  }
}

export async function POST(req: Request) {
  // 1. 认证
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }
  
  const userId = session.user.id
  
  // 2. 解析请求
  const { messages, id: chatId, modelId }: { 
    messages: UIMessage[]
    id: string 
    modelId:'deepseek-chat'|'deepseek-reasoner' // 切换模型
  } = await req.json()
  
  // 3. 取最后一条用户消息
  const lastMessage = messages[messages.length - 1]
  if ( !lastMessage || lastMessage.role !== 'user') {
    return new Response('Last message must be from user', { status: 400 })
  }
  
  // 这步是为了AI SDK 的 UIMessage 格式转换成数据库能存的纯文本字符串
  const userText = lastMessage.parts
    .filter(p => p.type === 'text')
    .map(p => (p as any).text)
    .join('')

  // 4. 确保 chat 存在（不存在就创建）
  const existingChat = await sql`SELECT id FROM chats WHERE id = ${chatId}`
  // 如果不存在 是一次新对话
  if (existingChat.length === 0) {
    // 用第一条消息生成标题（取前 30 字符）
    const title = await generateTitle(userText)
    // 存标题
    await sql`
      INSERT INTO chats (id, user_id, title) 
      VALUES (${chatId}, ${userId}, ${title})
    `
  }
  
  // 5. 存用户消息
  await sql`
    INSERT INTO messages (chat_id, role, content) 
    VALUES (${chatId}, 'user', ${userText})
  `
  
  // 6. 调用 AI
  // streamText 是 AI SDK 的核心函数，返回一个流式响应
  const result = streamText({
    model: models[modelId],
    // system：系统提示词，控制 AI 的行为风格
    system: '你是一个有帮助的 AI 助手。用中文回复。回复要简洁。',
    // convertToModelMessages 把前端的 UIMessage 格式转成模型能理解的格式
    messages: await convertToModelMessages(messages),
    maxOutputTokens: 1000, // 限制单次回复最大 token 数
    // AI 回复完成后存数据库
    onFinish: async ({ text,usage }) => {
      console.log('[AI] tokens used:', usage) // usage包含输入和输出token数
      // 存ai消息
      await sql`
        INSERT INTO messages (chat_id, role, content) 
        VALUES (${chatId}, 'assistant', ${text})
      `
    },
  })
  
  return result.toUIMessageStreamResponse()
}


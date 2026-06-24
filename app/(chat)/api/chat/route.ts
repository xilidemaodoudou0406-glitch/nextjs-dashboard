import { streamText, type UIMessage, convertToModelMessages } from 'ai'
import { chatModel } from '@/app/lib/ai/provider'
import { auth } from '@/auth'

// request类代表了一个即将被处理的 HTTP 请求的完整信息
export async function POST(req:Request) {
    // 1. 认证
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  // 2. 解析请求
  // 把传入进来的请求中解析出前端传过来的message（完整对话历史）
  const { messages }: { messages: UIMessage[] } = await req.json()

  // 3. 调用 AI,流式返回
  const result = streamText({
    model: chatModel,
    system: '你是一个有帮助的 AI 助手。用中文回复。回复要简洁。',
    messages: await convertToModelMessages(messages),
  })
  
  // 把流式结果转成 HTTP 响应（Server-Sent Events 格式），
  // 前端的 useChat 能直接消费。
  return result.toUIMessageStreamResponse()
}

// streamText 是 AI SDK 的核心函数，返回一个流式响应
// system：系统提示词，控制 AI 的行为风格
// convertToModelMessages 把前端的 UIMessage 格式转成模型能理解的格式
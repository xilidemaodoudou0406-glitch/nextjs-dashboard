// app/(chat)/page.tsx
import postgres from 'postgres'

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

export default async function ChatHomePage() {
  // 暂时硬编码一个 user_id，等做完认证再改
  const chats = await sql`
    SELECT id, title, created_at FROM chats 
    LIMIT 10
  `
  
  return (
    <main className="p-8">
      <h1 className="text-2xl mb-4">聊天首页（占位）</h1>
      <pre className="bg-gray-100 p-4 rounded">
        {JSON.stringify(chats, null, 2)}
      </pre>
    </main>
  )
}
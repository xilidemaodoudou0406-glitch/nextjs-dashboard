// app/(chat)/page.tsx
// import { auth } from '@/auth'
// import postgres from 'postgres'
// import { signOut } from '@/auth'

// const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

// export default async function ChatHomePage() {
//   // await auth() 拿当前 session
//   const session = await auth()
//   console.log('🔍 SESSION:', JSON.stringify(session, null, 2))  // ← 临时调试
//   // middleware 已经保护了未登录访问,但作为类型安全的兜底
//   if (!session?.user?.id) {
//     return <div>未登录 (debug: {JSON.stringify(session)})</div>
//   }
  
//   const userId = session.user.id
//   const chats = await sql`
//     SELECT id, title, created_at FROM chats 
//     WHERE user_id = ${userId}
//     ORDER BY created_at DESC
//   `
  
//   return (
//     <main className="p-8">
//       <h1 className="text-2xl mb-2">你好，{session.user.email}</h1>

//     {/* 绑定给form action的函数不能是普通函数 */}
//       <form action={async () => {
//         'use server'
//         await signOut({ redirectTo: '/login' })
//       }}>
//         <button className="bg-red-500 text-white px-3 py-1 rounded text-sm">
//           退出登录
//         </button>
//       </form>

//       <p className="text-gray-600 mb-4">你有 {chats.length} 次对话历史</p>
//       <pre className="bg-gray-100 p-4 rounded text-sm overflow-auto">
//         {JSON.stringify(chats, null, 2)}
//       </pre>
//     </main>
//   )
// }

// session.user.id 是 NextAuth 自动从 JWT 里解出来的
// 用 userId 去查这个用户自己的对话（数据隔离）


// app/(chat)/page.tsx
import { requireUser } from '@/app/lib/auth/require-user'
import Chat from './chat'

export default async function ChatHomePage() {
  await requireUser({ redirectTo: '/login' })
  
  // 为新对话生成 ID（crypto是一个全局可用的对象，无需导入）
  const newChatId = crypto.randomUUID() // 作为chat的id被存到数据库
  
  return <Chat key={newChatId} chatId={newChatId} />
}

// app/(chat)/sidebar.tsx
import { Suspense } from 'react'
import Link from 'next/link'
import { signOut } from '@/auth'
import ChatList from './chat-list'
import ChatListSkeleton from './chat-list-skeleton'

interface Props {
  userId: string
  userEmail: string
}

export default function Sidebar({ userId, userEmail }: Props) {
  return (
    <aside className="w-64 bg-gray-50 border-r flex flex-col h-full">
      {/* 顶部:新对话按钮 */}
      <div className="p-3 border-b">
        <Link
          href="/"
          className="flex items-center justify-center gap-2 w-full py-2 px-3 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          <span>+</span>
          <span>新对话</span>
        </Link>
      </div>
      
      {/* 中间:对话列表(用 Suspense 流式加载) */}
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<ChatListSkeleton />}>
          <ChatList userId={userId} />
        </Suspense>
      </div>
      
      {/* 底部:用户信息 + 退出 */}
      <div className="p-3 border-t">
        <div className="text-xs text-gray-500 mb-2 truncate">{userEmail}</div>
        <form action={async () => {
          'use server'
          await signOut({ redirectTo: '/login' })
        }}>
          <button className="w-full text-sm text-gray-700 hover:text-red-600">
            退出登录
          </button>
        </form>
      </div>
    </aside>
  )
}
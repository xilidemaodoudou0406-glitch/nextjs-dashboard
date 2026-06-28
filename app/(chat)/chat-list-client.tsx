// app/(chat)/chat-list-client.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ChatItem } from './chat-list'

interface Props {
  grouped: Record<string, ChatItem[]>
}

export default function ChatListClient({ grouped }: Props) {
  const pathname = usePathname()
  
  // 了解一下Object.value() 方法（转换成数组）
  // 是否一条对话都没有
  const isAllEmpty = Object.values(grouped).every(arr => arr.length === 0)
  if (isAllEmpty) {
    return (
      <div className="p-4 text-sm text-gray-400 text-center">
        还没有对话
      </div>
    )
  }
  
  return (
    <nav className="p-2">
      {/* 数组解构赋值，把每一项中的两项解构出来并赋值groupName, chats */}
      {Object.entries(grouped).map(([groupName, chats]) => {
        if (chats.length === 0) return null
        
        // 注意 react中涉及到循环遍历的时候也需要加一个key
        return (
          <div key={groupName} className="mb-4">
            <div className="px-2 py-1 text-xs font-medium text-gray-500">
              {groupName}
            </div>
            <ul>
              {/* 这里是循环渲染某个日期内所包含的所有对话 */}
              {/* 这里的chatid是chat-list中访问数据库查的 */}
              {chats.map((chat) => {
                const href = `/chat/${chat.id}`
                const isActive = pathname === href
                
                return (
                  <li key={chat.id}>
                    <Link
                      href={href}
                      className={`block px-2 py-1.5 text-sm rounded truncate ${
                        isActive
                          ? 'bg-blue-100 text-blue-900'
                          : 'text-gray-700 hover:bg-gray-200'
                      }`}
                      title={chat.title}
                    >
                      {chat.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
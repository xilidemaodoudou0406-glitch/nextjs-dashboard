// app/(chat)/chat-list-client.tsx
'use client'

import Link from 'next/link'
import { usePathname,useRouter } from 'next/navigation'
import type { ChatItem } from './chat-list'
import { useState, useTransition } from 'react'
import { deleteChat } from './action'

interface Props {
  grouped: Record<string, ChatItem[]>
}

export default function ChatListClient({ grouped }: Props) {
  const pathname = usePathname()
  const router = useRouter()
  // usestate的<string | null>限定的是内部pendingId的范围
  // 记录当前正在被删除的对话id
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [,startTransistion] = useTransition()
  
  const handleDelete = (chatId: string,e: React.MouseEvent) => {
    e.preventDefault() // 更多时候是防御性编程，让这个元素只执行这一个动作
    e.stopPropagation() // 阻止事件冒泡（这个要重点复习下）
    // 会终端线程跳出来一个选择框 实际上一般不用 会卡住线程 可以优化
    // js原生方法(返回布尔)
    if (!confirm('确定删除这个对话吗？')) return

    setPendingId(chatId)
    startTransistion( async () => {
      try{
        const result = await deleteChat(chatId)
        if (!result.ok) {
          alert('删除失败：' + result.error.message)
          return
        }
        // 如果当前正在查看被删的对话,跳回首页
        if (pathname === `/chat/${chatId}`) {
          router.push('/')
        }
      } catch (err) {
        alert('删除失败：' + (err as Error).message)
      } finally {
        setPendingId(null) // 删除完之后要把这个参数置空,除了删除中，其余情况都为null
      }
    })
  }

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
                const isPending = pendingId === chat.id

                return (
                  <li key={chat.id} className="group relative">
                    <Link
                      href={href}
                      className={`block px-2 py-1.5 text-sm rounded truncate ${
                        isActive
                          ? 'bg-blue-100 text-blue-900'
                          : 'text-gray-700 hover:bg-gray-200'
                      } ${isPending? 'opacity-50' : '' }`}
                      title={chat.title}
                    >
                      {chat.title}
                    </Link>

                    <button
                      onClick={(e) => handleDelete(chat.id,e)}
                      disabled={isPending}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-600 disabled:cursor-not-allowed"
                      aria-label="删除"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
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

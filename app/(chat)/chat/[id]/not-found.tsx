// app/(chat)/chat/[id]/not-found.tsx
// 当 notFound() 触发时，自动渲染这个页面。比默认 404 友好。

import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <h2 className="text-2xl font-semibold text-gray-800 mb-2">对话不存在</h2>
      <p className="text-gray-500 mb-6">
        这个对话可能已被删除,或者你没有访问权限
      </p>
      <Link 
        href="/"
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        回到首页
      </Link>
    </div>
  )
}
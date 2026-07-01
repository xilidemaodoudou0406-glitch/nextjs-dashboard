// app/(chat)/chat/[id]/loading.tsx
// loading文件是自动识别加载的 不需要做什么引入
export default function Loading() {
  return (
    <div className="flex flex-col flex-1 p-4 space-y-3">
      <div className="h-12 bg-gray-100 rounded animate-pulse" />
      <div className="h-24 bg-gray-100 rounded animate-pulse" />
      <div className="h-12 bg-gray-100 rounded animate-pulse w-2/3 ml-auto" />
      <div className="h-32 bg-gray-100 rounded animate-pulse" />
    </div>
  )
}
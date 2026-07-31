// app/(chat)/chat-list-skeleton.tsx
const skeletonWidths = ['78%', '64%', '86%', '71%', '82%']

export default function ChatListSkeleton() {
  return (
    <div className="p-2 space-y-2">
      {skeletonWidths.map((width) => (
        <div
          key={width}
          className="h-8 bg-gray-200 rounded animate-pulse"
          style={{ width }}
        />
      ))}
    </div>
  )
}

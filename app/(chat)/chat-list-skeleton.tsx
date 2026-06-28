// app/(chat)/chat-list-skeleton.tsx
export default function ChatListSkeleton() {
  return (
    <div className="p-2 space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-8 bg-gray-200 rounded animate-pulse"
          style={{ width: `${60 + Math.random() * 30}%` }}
        />
      ))}
    </div>
  )
}
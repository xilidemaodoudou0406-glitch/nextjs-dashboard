// app/(chat)/chat-input.tsx
// 输入框组件
'use client'

interface Props {
  value: string
  onChange: (val: string) => void
  onSubmit: (e: React.FormEvent) => void
  status: string
  onStop: () => void
}

export default function ChatInput({ value, onChange, onSubmit, status, onStop }: Props) {
  const isStreaming = status === 'streaming' || status === 'submitted'
  
  return (
    <form onSubmit={onSubmit} className="border-t p-4">
      <div className="flex gap-2 max-w-3xl mx-auto">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送,Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit(e as any)
            }
          }}
          placeholder="说点什么..."
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
        />
        
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            发送
          </button>
        )}
      </div>
    </form>
  )
}

// Enter 发送、Shift+Enter 换行（标准聊天框行为）
// 流式输出期间，"发送"按钮变成"停止"
// 空输入禁用发送按钮
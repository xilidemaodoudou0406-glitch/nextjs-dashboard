// app/(chat)/markdown.tsx
// 用来渲染组件
'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // 自定义代码块样式
          code({ className, children, ...props }) {
            const isInline = !className
            if (isInline) {
              return (
                <code className="bg-gray-200 text-gray-800 px-1 py-0.5 rounded text-sm" {...props}>
                  {children}
                </code>
              )
            }
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
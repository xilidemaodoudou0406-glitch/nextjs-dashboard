// components/suggestions.tsx
'use client';

const suggestions = [
  { title: '解释量子计算', desc: '用简单的语言' },
  { title: '写一个 React 组件', desc: '实现一个倒计时器' },
  { title: '翻译这段话', desc: '将中文翻译成地道的英文' },
  { title: '帮我制定计划', desc: '周末去杭州两日游' },
];

// 要传入一个传递消息的函数 onSend，点击按钮时调用这个函数
export function Suggestions({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4 max-w-2xl mx-auto mb-8">
      {suggestions.map((s, i) => (
        <button
          key={i}
          onClick={() => onSend(`${s.title}，${s.desc}`)}
          className="text-left p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <div className="font-medium text-gray-900 dark:text-gray-100">{s.title}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{s.desc}</div>
        </button>
      ))}
    </div>
  );
}

// 此处有一个待优化点，在点击完
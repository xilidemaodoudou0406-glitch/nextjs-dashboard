// components/model-selector.tsx
// 选择模型组件
'use client';

const MODEL_OPTIONS = [
  { id: 'deepseek-chat', name: 'DeepSeek V3 (快速)' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1 (深度思考)' },
];

export function ModelSelector({ currentModel, onModelChange }: { currentModel: string, onModelChange: (id: string) => void }) {
  return (
    <select 
      value={currentModel} 
      onChange={(e) => onModelChange(e.target.value)}
      className="bg-transparent border rounded px-2 py-1 text-sm"
    >
      {MODEL_OPTIONS.map(opt => (
        <option key={opt.id} value={opt.id}>{opt.name}</option>
      ))}
    </select>
  );
}
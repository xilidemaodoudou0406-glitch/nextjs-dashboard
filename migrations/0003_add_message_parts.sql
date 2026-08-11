-- content 继续保留为可检索、可生成标题的纯文本；parts 保存 UIMessage 的
-- 结构化内容，使图片 URL 在刷新页面和分支继承上下文后仍然存在。
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS parts JSONB;

UPDATE messages
SET parts = jsonb_build_array(
  jsonb_build_object('type', 'text', 'text', content)
)
WHERE parts IS NULL;

ALTER TABLE messages
ALTER COLUMN parts SET DEFAULT '[]'::jsonb,
ALTER COLUMN parts SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_parts_array_check'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
    ADD CONSTRAINT messages_parts_array_check
    CHECK (jsonb_typeof(parts) = 'array');
  END IF;
END
$$;

-- 阶段一只需要区分“完整回答”和“被中断的部分回答”。
-- useChat 的 ready/submitted/streaming/error 是前端瞬时状态，不写入本列。
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS status VARCHAR(20);

UPDATE messages
SET status = 'completed'
WHERE status IS NULL OR status NOT IN ('completed', 'interrupted');

ALTER TABLE messages
ALTER COLUMN status SET DEFAULT 'completed',
ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_status_check'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
    ADD CONSTRAINT messages_status_check
    CHECK (status IN ('completed', 'interrupted'));
  END IF;
END
$$;

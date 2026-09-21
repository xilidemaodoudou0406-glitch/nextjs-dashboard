-- 为分支可见范围提供稳定、全局递增的消息顺序。
-- 过去 created_at 相同的时候会使用随机 UUID 比较先后，不能严格表达插入顺序。
CREATE SEQUENCE IF NOT EXISTS messages_sequence_no_seq;

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS sequence_no BIGINT;

WITH ranked_messages AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS sequence_no
  FROM messages
)
UPDATE messages AS message
SET sequence_no = ranked_messages.sequence_no
FROM ranked_messages
WHERE message.id = ranked_messages.id
  AND message.sequence_no IS NULL;

SELECT setval(
  'messages_sequence_no_seq',
  GREATEST(COALESCE((SELECT MAX(sequence_no) FROM messages), 0) + 1, 1),
  false
);

ALTER TABLE messages
ALTER COLUMN sequence_no SET DEFAULT nextval('messages_sequence_no_seq'),
ALTER COLUMN sequence_no SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_sequence_no_key
ON messages(sequence_no);

CREATE INDEX IF NOT EXISTS messages_chat_id_sequence_no_idx
ON messages(chat_id, sequence_no ASC);

-- conversation_memories 继续是可以从 messages 重建的派生索引；下面的字段
-- 用于区分“原始证据”和“参与检索的精简文本”，并为后续记忆更新留出边界。
ALTER TABLE conversation_memories
ADD COLUMN IF NOT EXISTS retrieval_text TEXT,
ADD COLUMN IF NOT EXISTS memory_type VARCHAR(30),
ADD COLUMN IF NOT EXISTS memory_key VARCHAR(200),
ADD COLUMN IF NOT EXISTS keywords TEXT[],
ADD COLUMN IF NOT EXISTS importance REAL,
ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS superseded_by UUID;

UPDATE conversation_memories
SET
  retrieval_text = COALESCE(retrieval_text, content),
  memory_type = COALESCE(memory_type, 'discussion'),
  keywords = COALESCE(keywords, ARRAY[]::TEXT[]),
  importance = COALESCE(importance, 0.5)
WHERE
  retrieval_text IS NULL
  OR memory_type IS NULL
  OR keywords IS NULL
  OR importance IS NULL;

ALTER TABLE conversation_memories
ALTER COLUMN retrieval_text SET NOT NULL,
ALTER COLUMN memory_type SET DEFAULT 'discussion',
ALTER COLUMN memory_type SET NOT NULL,
ALTER COLUMN keywords SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN keywords SET NOT NULL,
ALTER COLUMN importance SET DEFAULT 0.5,
ALTER COLUMN importance SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversation_memories_type_check'
      AND conrelid = 'conversation_memories'::regclass
  ) THEN
    ALTER TABLE conversation_memories
    ADD CONSTRAINT conversation_memories_type_check
    CHECK (
      memory_type IN (
        'user_fact',
        'preference',
        'decision',
        'requirement',
        'discussion'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversation_memories_importance_check'
      AND conrelid = 'conversation_memories'::regclass
  ) THEN
    ALTER TABLE conversation_memories
    ADD CONSTRAINT conversation_memories_importance_check
    CHECK (importance >= 0 AND importance <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversation_memories_superseded_by_fkey'
      AND conrelid = 'conversation_memories'::regclass
  ) THEN
    ALTER TABLE conversation_memories
    ADD CONSTRAINT conversation_memories_superseded_by_fkey
    FOREIGN KEY (superseded_by)
    REFERENCES conversation_memories(id)
    ON DELETE SET NULL;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS conversation_memories_retrieval_text_trgm_idx
ON conversation_memories
USING GIN (retrieval_text gin_trgm_ops)
WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS conversation_memories_active_scope_idx
ON conversation_memories(user_id, chat_id, created_at DESC)
WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS conversation_memories_active_key_idx
ON conversation_memories(user_id, chat_id, memory_key)
WHERE memory_key IS NOT NULL AND invalidated_at IS NULL;

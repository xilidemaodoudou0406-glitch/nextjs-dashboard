-- 阶段二只为 chats 增加最小来源关系，不创建额外的分支表。
ALTER TABLE chats
ADD COLUMN IF NOT EXISTS parent_chat_id UUID,
ADD COLUMN IF NOT EXISTS branch_from_message_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chats_parent_chat_id_fkey'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
    ADD CONSTRAINT chats_parent_chat_id_fkey
    FOREIGN KEY (parent_chat_id)
    REFERENCES chats(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chats_branch_from_message_id_fkey'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
    ADD CONSTRAINT chats_branch_from_message_id_fkey
    FOREIGN KEY (branch_from_message_id)
    REFERENCES messages(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chats_branch_relation_pair_check'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
    ADD CONSTRAINT chats_branch_relation_pair_check
    CHECK (
      (parent_chat_id IS NULL AND branch_from_message_id IS NULL)
      OR
      (parent_chat_id IS NOT NULL AND branch_from_message_id IS NOT NULL)
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chats_parent_not_self_check'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
    ADD CONSTRAINT chats_parent_not_self_check
    CHECK (parent_chat_id IS NULL OR parent_chat_id <> id);
  END IF;

  -- PostgreSQL 的 UNIQUE 允许存在多个 NULL，因此主对话不会互相冲突；
  -- 非空锚点则被限制为“一条 assistant 消息最多一个分支”。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chats_branch_from_message_id_key'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
    ADD CONSTRAINT chats_branch_from_message_id_key
    UNIQUE (branch_from_message_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS chats_parent_chat_id_idx
ON chats(parent_chat_id);

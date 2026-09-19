SET LOCAL lock_timeout = '5s';
ALTER TABLE usage ADD COLUMN provider text;
ALTER TABLE usage ADD COLUMN model text;
ALTER TABLE tasks ADD COLUMN ai_provider text CHECK (ai_provider IN ('anthropic','openai'));
ALTER TABLE tasks ADD COLUMN ai_model text;

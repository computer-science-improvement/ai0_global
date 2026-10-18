-- 082_agent_voice.sql — one grammatical voice per agent (spec 047 FR-006).
--
-- • agents.grammatical_gender: the gender an agent uses for itself in Ukrainian («я зробив» / «я зробила»), so one agent
--   never switches mid-chat. NULL = masculine. Set on create, editable on the agent page and through the @ai0 card.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS grammatical_gender TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_grammatical_gender_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_grammatical_gender_check CHECK (grammatical_gender IN ('masculine', 'feminine'));
  END IF;
END $$;

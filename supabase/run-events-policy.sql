-- Run this through the Supabase SQL editor (owner context) when the ordinary
-- application migration role cannot alter the locked realtime schema.
-- Idempotent and safe to repeat.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "run_events_members_can_receive" ON realtime.messages;
CREATE POLICY "run_events_members_can_receive"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND public.can_access_run_events((SELECT realtime.topic()))
);

'use strict';
// GI · Error Handler: set as errorWorkflow on every GI workflow.
module.exports = {
  id: 'giErrorHandler01',
  file: 'gold-intelligence-error-handler.json',
  build(h) {
    h.lane(0);
    const trig = h.errorTrigger('Error Trigger');
    const cls = h.code('Classify Error', 'error/classify.js', { notes: 'workflow · node · error · execution · severity (secrets redacted)' });
    const rec = h.pg('Record Error', `
WITH p AS (SELECT $1::jsonb AS j),
-- n8n re-reports crashed executions on every restart: one record / alert per execution.
dup AS (
  SELECT EXISTS (SELECT 1 FROM error_events ee, p WHERE p.j->'error'->>'execution_id' IS NOT NULL
    AND ee.execution_id = p.j->'error'->>'execution_id' AND ee.workflow_id IS NOT DISTINCT FROM p.j->'error'->>'workflow_id') AS seen
),
ins AS (
  INSERT INTO error_events (workflow_id, workflow_name, node_name, error_message, error_type, execution_id, execution_url, severity, mode)
  SELECT e->>'workflow_id', e->>'workflow_name', e->>'node_name', e->>'error_message', e->>'error_type', e->>'execution_id',
         e->>'execution_url', e->>'severity', e->>'mode'
  FROM p, LATERAL (SELECT p.j->'error' AS e) x WHERE NOT (SELECT seen FROM dup) RETURNING id
),
last AS (SELECT (value->>'at')::timestamptz AS at FROM kv_state WHERE key = 'tech_alert_last'),
decide AS (
  SELECT (NOT (SELECT seen FROM dup) AND coalesce((p.j->>'alertable')::boolean, true)
    AND ((SELECT at FROM last) IS NULL OR (SELECT at FROM last) < now() - make_interval(mins => coalesce((p.j->>'cooldown_min')::int, 60)))) AS send FROM p
),
kv AS (
  INSERT INTO kv_state (key, value, updated_at) SELECT 'tech_alert_last', jsonb_build_object('at', now()), now() FROM decide WHERE send
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
hs AS (
  INSERT INTO system_health (component, status, detail) SELECT 'WORKFLOW_ERRORS', 'DEGRADED', left(p.j->'error'->>'workflow_name' || ': ' || coalesce(p.j->'error'->>'error_message', ''), 300) FROM p WHERE NOT (SELECT seen FROM dup) RETURNING 1
)
SELECT (SELECT send FROM decide) AS send, (SELECT id FROM ins) AS error_id, (SELECT seen FROM dup) AS duplicate`, '$json', { onError: 'continueRegularOutput', notes: 'DB failure → continue with static-data cooldown' });
    const decide = h.code('Alert Decision', 'error/decide.js');
    const iff = h.ifTrue('Send Alert?', '$json.send === true');
    const send = h.code('Send Tech Alert', 'error/send.js', { notes: 'direct Telegram, no DB dependency' });
    h.chain(trig, cls, rec, decide, iff);
    h.connect(iff, send, 0);
    h.note('About', '## GI · Error Handler\nRecords workflow, node, error, timestamp, execution id and severity in `error_events` (once per execution: n8n re-reports crashed executions after every restart); sends a Telegram technical alert with cooldown (`GI_TECH_ALERT_COOLDOWN_MIN`). Secrets are redacted. Works even if the database is down.', [0, 240], [560, 170], 3);
    return h.result({ name: 'GI · Error Handler', noErrorWorkflow: true });
  },
};

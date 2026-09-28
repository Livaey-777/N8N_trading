'use strict';
// GI · Master Pipeline: live news intelligence + market context / desk state + synthetic test.
const SERIES = (instrument, days) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, value AS v, source AS src FROM market_observations
    WHERE instrument = '${instrument}' AND observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value, source FROM market_observations
      WHERE instrument = '${instrument}' AND observed_at <= now() - interval '8 days' AND observed_at > now() - interval '${days} days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d
  ) s)`;

module.exports = {
  id: 'giMasterPipeline',
  file: 'gold-intelligence-master.json',
  build(h) {
    // ------------------------------------------------------------------ news lane
    h.lane(0);
    const newsTrigger = h.schedule('⏱ News Schedule', { field: 'minutes', minutesInterval: '={{ Number($env.GI_NEWS_INTERVAL_MIN) || 15 }}' }, { notes: 'GI_NEWS_INTERVAL_MIN (default 15)' });
    const start = h.code('Start News Run', 'master/news-start.js');
    h.at(0, 1);
    const synth = h.manual('🧪 Synthetic Event Test');
    const synthBuild = h.code('Build Synthetic Reports', 'master/synthetic-reports.js', { notes: '3 reports of one simulated event + 2 noise items' });
    h.at(2, 0);
    const loadCtx = h.pg('Load News Context', `
WITH p AS (SELECT $1::jsonb AS j)
SELECT (SELECT j FROM p) AS run,
 (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.tier, s.id), '[]'::jsonb) FROM (
    SELECT id, name, publisher, url, kind, tier, category_hint, consecutive_failures FROM sources
    WHERE enabled AND poll_group = 'news') s) AS sources,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT ev.id, ev.event_key, ev.title, ev.category, ev.subcategory, ev.region, ev.first_seen_at, ev.last_seen_at,
           ev.best_tier, ev.source_count, ev.publisher_count, ev.publishers, ev.tokens, ev.classification, ev.signature,
           ev.alert_signature, ev.last_alerted_at, ev.alert_count, ev.importance_class, ev.net_pressure, ev.is_test,
           (SELECT coalesce(jsonb_object_agg(tier, n), '{}'::jsonb) FROM (
              SELECT tier, count(DISTINCT publisher) AS n FROM event_sources WHERE event_id = ev.id GROUP BY tier) t) AS tier_counts,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('publisher', publisher, 'tier', tier, 'title', title, 'url', url, 'published_at', published_at) ORDER BY tier, published_at), '[]'::jsonb)
              FROM (SELECT * FROM event_sources WHERE event_id = ev.id ORDER BY tier, published_at LIMIT 5) r) AS reports
    FROM events ev WHERE ev.last_seen_at > now() - interval '72 hours' ORDER BY ev.last_seen_at DESC LIMIT 400) e) AS recent_events,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', price, 'src', source) ORDER BY observed_at), '[]'::jsonb)
    FROM gold_observations WHERE observed_at > now() - interval '4 days') AS gold_series,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'USD_PROXY' AND observed_at > now() - interval '4 days') AS usd_series,
 (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
    SELECT id, release_key, event_type, title, scheduled_at, consensus, previous, actual, surprise FROM macro_releases
    WHERE scheduled_at BETWEEN now() - interval '14 hours' AND now() + interval '2 hours') r) AS releases_now,
 (SELECT coalesce(jsonb_object_agg(event_type, s), '{}'::jsonb) FROM (
    SELECT event_type, jsonb_build_object('n', count(*),
      'bullish', count(*) FILTER (WHERE gold_direction = 'BULLISH'),
      'bearish', count(*) FILTER (WHERE gold_direction = 'BEARISH'),
      'mixed', count(*) FILTER (WHERE gold_direction = 'MIXED'),
      'median_abs_4h_pct', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(gold_4h / gold_before - 1) * 100))::numeric, 2)) AS s
    FROM historical_event_reactions WHERE data_quality <> 'INSUFFICIENT' AND gold_before > 0 AND gold_4h > 0 GROUP BY event_type) x) AS hist_summary,
 (SELECT final FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY created_at DESC LIMIT 1) AS desk`,
    '$json.run', { notes: 'sources, recent events (72h), market series, releases, history' });
    const buildReq = h.code('Build Feed Requests', 'master/feed-requests.js');
    const liveFetch = h.ifTrue('Live Fetch?', '$json.fetch === true');
    const fetchFeeds = h.http('Fetch Feeds', { batchSize: 4, batchInterval: 300, timeout: 25000, notes: 'per-source failure is isolated (continue on error)' });
    const parse = h.code('Parse & Normalize Reports', 'master/parse-reports.js', { notes: 'SOURCE VALIDATION + NORMALISATION' });
    h.at(7, 1);
    const seen = h.pg('Check Seen Items & Source Health', `
WITH p AS (SELECT $1::jsonb AS j),
upd AS (
  UPDATE sources s SET
    last_ok_at = CASE WHEN (h->>'ok')::boolean THEN now() ELSE s.last_ok_at END,
    last_error_at = CASE WHEN (h->>'ok')::boolean THEN s.last_error_at ELSE now() END,
    last_error = CASE WHEN (h->>'ok')::boolean THEN NULL ELSE left(h->>'error', 300) END,
    consecutive_failures = CASE WHEN (h->>'ok')::boolean THEN 0 ELSE s.consecutive_failures + 1 END,
    last_item_count = (h->>'items')::int,
    updated_at = now()
  FROM p, jsonb_array_elements(coalesce(p.j->'source_health', '[]'::jsonb)) h
  WHERE s.id = h->>'source_id'
  RETURNING s.id
)
SELECT coalesce((SELECT jsonb_agg(n.item_hash) FROM news_items n
                 WHERE n.item_hash IN (SELECT jsonb_array_elements_text(coalesce((SELECT j->'hashes' FROM p), '[]'::jsonb)))), '[]'::jsonb) AS seen,
       (SELECT count(*) FROM upd)::int AS sources_updated`,
    '{ hashes: $json.hashes, source_health: $json.source_health }', { notes: 'exact dedup vs storage' });
    const cluster = h.code('Classify, Score & Cluster', 'master/classify-cluster.js', { notes: 'relevance · clustering · importance · transmission · confirmation' });
    const persist = h.pg('Persist Events', `
WITH p AS (SELECT $1::jsonb AS j),
ev AS (
  INSERT INTO events (event_key, title, summary, category, subcategory, region, first_seen_at, last_seen_at, published_at,
    source_count, publisher_count, publishers, best_tier, gold_relevance_score, importance_score, importance_class,
    confirmation_status, net_pressure, net_score, dominant_driver, counter_driver, transmission, keywords,
    horizon_biases, market_confirmation, tokens, signature, classification, linked_release_id, is_test)
  SELECT e->>'event_key', e->>'title', e->>'summary', e->>'category', e->>'subcategory', e->>'region',
    (e->>'first_seen_at')::timestamptz, (e->>'last_seen_at')::timestamptz, (e->>'published_at')::timestamptz,
    (e->>'source_count')::int, (e->>'publisher_count')::int, ARRAY(SELECT jsonb_array_elements_text(e->'publishers')),
    (e->>'best_tier')::smallint, (e->>'gold_relevance_score')::int, (e->>'importance_score')::int, e->>'importance_class',
    e->>'confirmation_status', e->>'net_pressure', (e->>'net_score')::numeric, e->>'dominant_driver', e->>'counter_driver',
    coalesce(e->'transmission', '[]'::jsonb), ARRAY(SELECT jsonb_array_elements_text(coalesce(e->'keywords', '[]'::jsonb))),
    e->'horizon_biases', e->'market_confirmation', ARRAY(SELECT jsonb_array_elements_text(coalesce(e->'tokens', '[]'::jsonb))),
    e->>'signature', e->'classification', (e->>'linked_release_id')::bigint, coalesce((e->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'events', '[]'::jsonb)) e
  ON CONFLICT (event_key) DO UPDATE SET
    title = EXCLUDED.title, category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, region = EXCLUDED.region,
    first_seen_at = LEAST(events.first_seen_at, EXCLUDED.first_seen_at), last_seen_at = GREATEST(events.last_seen_at, EXCLUDED.last_seen_at),
    source_count = EXCLUDED.source_count, publisher_count = EXCLUDED.publisher_count, publishers = EXCLUDED.publishers,
    best_tier = LEAST(events.best_tier, EXCLUDED.best_tier), gold_relevance_score = EXCLUDED.gold_relevance_score,
    importance_score = EXCLUDED.importance_score, importance_class = EXCLUDED.importance_class,
    confirmation_status = EXCLUDED.confirmation_status, net_pressure = EXCLUDED.net_pressure, net_score = EXCLUDED.net_score,
    dominant_driver = EXCLUDED.dominant_driver, counter_driver = EXCLUDED.counter_driver, transmission = EXCLUDED.transmission,
    keywords = EXCLUDED.keywords, horizon_biases = EXCLUDED.horizon_biases, market_confirmation = EXCLUDED.market_confirmation,
    tokens = EXCLUDED.tokens, signature = EXCLUDED.signature, classification = EXCLUDED.classification,
    linked_release_id = coalesce(EXCLUDED.linked_release_id, events.linked_release_id), updated_at = now()
  RETURNING id, event_key
),
it AS (
  INSERT INTO news_items (item_hash, source_id, publisher, title, summary, url, published_at, fetched_at, effective_tier,
                          category, relevance_score, status, event_id, is_test)
  SELECT i->>'item_hash', i->>'source_id', i->>'publisher', i->>'title', i->>'summary', i->>'url',
         (i->>'published_at')::timestamptz, (i->>'fetched_at')::timestamptz, (i->>'effective_tier')::smallint,
         i->>'category', (i->>'relevance_score')::int, i->>'status',
         (SELECT ev.id FROM ev WHERE ev.event_key = i->>'event_key'), coalesce((i->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'items', '[]'::jsonb)) i
  ON CONFLICT (item_hash) DO NOTHING
  RETURNING id, item_hash, event_id, source_id, publisher, effective_tier, url, title, published_at
),
es AS (
  INSERT INTO event_sources (event_id, news_item_id, source_id, publisher, tier, url, title, published_at)
  SELECT event_id, id, source_id, publisher, effective_tier, url, title, published_at FROM it WHERE event_id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'event_key', event_key)), '[]'::jsonb) FROM ev) AS events,
       (SELECT count(*) FROM it)::int AS items_inserted,
       (SELECT count(*) FROM es)::int AS links`, '$json.persist', { notes: 'events + news_items + event_sources (one statement)' });
    h.at(10, 1);
    const gateway = h.code('AI Gateway', 'master/ai-gateway.js', { notes: 'only validated HIGH-relevance/importance events reach AI' });
    const ai = h.callWorkflow('AI Analyst', 'giAiAnalystSub01');
    const compose = h.code('Compose Alerts', 'master/compose-alerts.js');
    const tg = h.callWorkflow('Telegram Sender', 'giTelegramSend01');
    const recordPayload = h.code('Prepare Run Record', 'master/record-payload.js');
    const record = h.pg('Record Run', `
WITH p AS (SELECT $1::jsonb AS j),
an AS (
  INSERT INTO analysis_results (analysis_type, event_id, mode, model, deterministic, ai_output, final, regime, short_bias,
                                tactical_bias, swing_bias, structural_bias, confidence, data_quality, is_test)
  SELECT 'EVENT', (a->>'event_id')::bigint, a->>'mode', a->>'model', coalesce(a->'deterministic', a->'final'), a->'ai_output', a->'final',
         a->>'regime', a->>'short_bias', a->>'tactical_bias', a->>'swing_bias', a->>'structural_bias', (a->>'confidence')::int,
         a->>'data_quality', coalesce((a->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'analyses', '[]'::jsonb)) a
  RETURNING id, event_id
),
upd AS (
  UPDATE events e SET
    ai_analysis_id = coalesce((SELECT max(an.id) FROM an WHERE an.event_id = e.id), e.ai_analysis_id),
    alert_signature = CASE WHEN (u->>'alerted')::boolean THEN u->>'signature' ELSE e.alert_signature END,
    last_alerted_at = CASE WHEN (u->>'alerted')::boolean THEN now() ELSE e.last_alerted_at END,
    alert_count = e.alert_count + CASE WHEN (u->>'alerted')::boolean THEN 1 ELSE 0 END,
    updated_at = now()
  FROM p, jsonb_array_elements(coalesce(p.j->'event_updates', '[]'::jsonb)) u
  WHERE e.id = (u->>'event_id')::bigint
  RETURNING e.id
),
jr AS (
  INSERT INTO job_runs (job, started_at, finished_at, status, stats, execution_id, is_test)
  SELECT p.j->>'job', (p.j->>'started_at')::timestamptz, now(), p.j->>'status', p.j->'stats', p.j->>'execution_id',
         coalesce((p.j->>'is_test')::boolean, false) FROM p
  RETURNING id
)
SELECT (SELECT count(*) FROM an)::int AS analyses, (SELECT count(*) FROM upd)::int AS events_updated, (SELECT id FROM jr) AS job_run_id`,
    '$json.record');
    h.chain(newsTrigger, start, loadCtx);
    h.chain(synth, synthBuild, loadCtx);
    h.chain(loadCtx, buildReq, liveFetch);
    h.connect(liveFetch, fetchFeeds, 0);
    h.connect(liveFetch, parse, 1);
    h.chain(fetchFeeds, parse, seen, cluster, persist, gateway, ai, compose, tg, recordPayload, record);

    // ---------------------------------------------------------------- market lane
    h.lane(3);
    const mktTrigger = h.schedule('⏱ Market Schedule', { field: 'minutes', minutesInterval: '={{ Number($env.GI_MARKET_INTERVAL_MIN) || 10 }}' }, { notes: 'GI_MARKET_INTERVAL_MIN (default 10)' });
    const mktCtx = h.pg('Load Market Context', `
SELECT now() AS started_at,
 (SELECT to_jsonb(k) FROM (SELECT value FROM kv_state WHERE key = 'market_fetch_state') k) AS fetch_state,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, price AS v, source AS src FROM gold_observations WHERE observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, price, source FROM gold_observations
      WHERE observed_at <= now() - interval '8 days' AND observed_at > now() - interval '130 days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) g) AS gold,
 ${SERIES('USD_PROXY', 130)} AS usd,
 ${SERIES('US2Y', 130)} AS us2y,
 ${SERIES('US10Y', 130)} AS us10y,
 ${SERIES('US30Y', 130)} AS us30y,
 ${SERIES('US10Y_REAL', 130)} AS us10y_real,
 ${SERIES('WTI', 130)} AS wti,
 ${SERIES('VIX', 130)} AS vix,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value, 'src', source) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'GOLD_COT_NONCOMM_NET' AND observed_at > now() - interval '1150 days') AS cot,
 (SELECT final->'desk' FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY created_at DESC LIMIT 1) AS prev_desk,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT id, title, category, subcategory, importance_score, gold_relevance_score, net_pressure, first_seen_at, last_seen_at, transmission FROM events
    WHERE NOT is_test AND last_seen_at > now() - interval '95 days' AND gold_relevance_score >= 35
    ORDER BY last_seen_at DESC LIMIT 600) e) AS events,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('event_date', x.event_date, 'actual', x.actual)), '[]'::jsonb) FROM (
    SELECT event_date, actual FROM historical_event_reactions WHERE event_type = 'CPI' AND actual IS NOT NULL
    UNION ALL SELECT scheduled_at, actual_num FROM macro_releases WHERE event_type = 'CPI' AND actual_num IS NOT NULL) x) AS cpi_rows,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('event_date', x.event_date, 'actual', x.actual)), '[]'::jsonb) FROM (
    SELECT event_date, actual FROM historical_event_reactions WHERE event_type = 'NFP' AND actual IS NOT NULL
    UNION ALL SELECT scheduled_at, actual_num FROM macro_releases WHERE event_type = 'NFP' AND actual_num IS NOT NULL) x) AS nfp_rows,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value FROM market_observations
    WHERE instrument = 'US2Y' AND observed_at > now() - interval '120 days' ORDER BY date_trunc('day', observed_at), observed_at DESC) s) AS us2y_long`, null, { notes: '8d intraday + 130d daily history, COT 3y, prior desk' });
    const plan = h.code('Plan Market Requests', 'master/market-requests.js');
    const fetchMkt = h.http('Fetch Market Data', { batchSize: 3, batchInterval: 250, timeout: 25000, notes: 'gold-api · Coinbase FX · Treasury · CFTC' });
    const mktParse = h.code('Compute Market & Desk State', 'master/market-parse.js', { notes: 'snapshot · multi-horizon bias · regime (hysteresis)' });
    const mktPersist = h.pg('Persist Market & Desk', `
WITH p AS (SELECT $1::jsonb AS j),
mo AS (
  INSERT INTO market_observations (observed_at, instrument, value, unit, source, resolution, quality, details)
  SELECT (o->>'observed_at')::timestamptz, o->>'instrument', (o->>'value')::numeric, o->>'unit', o->>'source', o->>'resolution',
         coalesce(o->>'quality', 'OK'), o->'details'
  FROM p, jsonb_array_elements(coalesce(p.j->'observations', '[]'::jsonb)) o
  ON CONFLICT (instrument, source, observed_at) DO NOTHING RETURNING 1
),
go AS (
  INSERT INTO gold_observations (observed_at, price, source, quality)
  SELECT (g->>'observed_at')::timestamptz, (g->>'price')::numeric, g->>'source', coalesce(g->>'quality', 'OK')
  FROM p, jsonb_array_elements(coalesce(p.j->'gold', '[]'::jsonb)) g
  ON CONFLICT (source, observed_at) DO NOTHING RETURNING 1
),
ds AS (
  INSERT INTO analysis_results (analysis_type, mode, deterministic, final, regime, short_bias, tactical_bias, swing_bias,
                                structural_bias, confidence, data_quality, is_test)
  SELECT 'DESK_STATE', 'DETERMINISTIC', p.j->'desk', jsonb_build_object('desk', p.j->'desk', 'snapshot', p.j->'snapshot'),
         p.j->'desk'->>'regime', p.j->'desk'->'horizons'->'SHORT'->>'bias', p.j->'desk'->'horizons'->'TACTICAL'->>'bias',
         p.j->'desk'->'horizons'->'SWING'->>'bias', p.j->'desk'->'horizons'->'STRUCTURAL'->>'bias',
         (p.j->'desk'->>'confidence')::int, p.j->'desk'->>'data_quality', false
  FROM p RETURNING id
),
hs AS (
  INSERT INTO system_health (component, status, detail, metrics)
  SELECT hh->>'component', hh->>'status', hh->>'detail', hh->'metrics'
  FROM p, jsonb_array_elements(coalesce(p.j->'health', '[]'::jsonb)) hh RETURNING 1
),
kv AS (
  INSERT INTO kv_state (key, value, updated_at) SELECT 'market_fetch_state', p.j->'fetch_state', now() FROM p
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
jr AS (
  INSERT INTO job_runs (job, started_at, finished_at, status, stats, execution_id)
  SELECT 'MARKET', (p.j->>'started_at')::timestamptz, now(), p.j->>'status', p.j->'stats', p.j->>'execution_id' FROM p RETURNING id
)
SELECT (SELECT count(*) FROM mo)::int AS market_rows, (SELECT count(*) FROM go)::int AS gold_rows,
       (SELECT id FROM ds) AS desk_id, (SELECT id FROM jr) AS job_run_id`, '$json.persist');
    const regimeMsg = h.code('Regime Change Message', 'master/regime-message.js');
    const regimeIf = h.ifTrue('Regime Changed?', '$json.send === true');
    const regimeTg = h.callWorkflow('Send Regime Change', 'giTelegramSend01');
    h.chain(mktTrigger, mktCtx, plan, fetchMkt, mktParse, mktPersist, regimeMsg, regimeIf);
    h.connect(regimeIf, regimeTg, 0);

    h.note('Pipeline', '## GI · Master Pipeline\n**DATA SOURCES → SOURCE VALIDATION → NORMALISATION → DEDUPLICATION → EVENT CLUSTERING → GOLD RELEVANCE → IMPORTANCE → MARKET CONTEXT → GOLD TRANSMISSION → HISTORICAL CONTEXT → AI ANALYST → TELEGRAM → STORAGE**\n\n* News every `GI_NEWS_INTERVAL_MIN`; market/desk every `GI_MARKET_INTERVAL_MIN`.\n* 🧪 *Synthetic Event Test* runs the full chain on simulated reports (flagged `is_test`).\n* Intelligence only — no broker, no orders.', [0, 820], [620, 260], 4);
    return h.result({ name: 'GI · Master Pipeline (news + market)' });
  },
};

'use strict';
/**
 * AI analyst gateway (OpenRouter): prompt construction, model router with
 * fallback (PRIMARY -> SECONDARY -> TERTIARY -> DETERMINISTIC), strict JSON
 * schema validation and a factuality guard. The AI may only interpret the
 * verified structured inputs it is given; it never supplies raw data.
 */
const { redact, round } = require('./util');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const BIAS_ENUM = ['BULLISH', 'BEARISH', 'MIXED', 'NEUTRAL', 'UNDETERMINED'];
const STRING_FIELDS = ['summary', 'interpretation', 'dominant_driver', 'secondary_driver', 'counter_driver', 'market_confirmation', 'regime',
  'short_bias', 'tactical_bias', 'swing_bias', 'structural_bias', 'bullish_scenario', 'base_scenario', 'bearish_scenario', 'telegram_summary'];
const ARRAY_FIELDS = ['facts', 'historical_context', 'bullish_forces', 'bearish_forces', 'invalidation_conditions', 'uncertainty'];
const BIAS_FIELDS = ['short_bias', 'tactical_bias', 'swing_bias', 'structural_bias'];
const MAX_LEN = { summary: 700, interpretation: 1400, telegram_summary: 900, bullish_scenario: 700, base_scenario: 700, bearish_scenario: 700 };

const OUTPUT_TEMPLATE = {
  summary: '', facts: [], historical_context: [], interpretation: '', dominant_driver: '', secondary_driver: '', counter_driver: '',
  bullish_forces: [], bearish_forces: [], market_confirmation: '', regime: '', short_bias: '', tactical_bias: '', swing_bias: '',
  structural_bias: '', bullish_scenario: '', base_scenario: '', bearish_scenario: '', invalidation_conditions: [], confidence: 0,
  uncertainty: [], telegram_summary: '',
};

const SYSTEM_PROMPT = [
  'You are the senior analyst of a XAUUSD (gold) macro-intelligence desk. You interpret verified inputs; you never invent data.',
  'RULES:',
  '1. Use ONLY the facts in the INPUT JSON. Do not add prices, yields, dates, economic figures, probabilities, statistics, quotes, names or events that are not in the input.',
  '2. Every number you write must appear in the input (you may round). If a number is not in the input, describe qualitatively instead.',
  '3. Do not predict undisclosed future information. For scheduled events give conditional scenarios, never the outcome.',
  '4. Do not force a direction. If forces conflict or evidence is thin, say MIXED or UNDETERMINED and explain the conflict.',
  '5. Explain the transmission to gold (real yields, USD, safe haven, policy path, inflation, positioning, flows), not just the headline.',
  '6. This is intelligence only. Never give trade instructions, entries, stops, targets or position sizes.',
  '7. Biases must be one of: BULLISH, BEARISH, MIXED, NEUTRAL, UNDETERMINED. confidence is an integer 0-100 and must not exceed input.deterministic.confidence + 10.',
  '8. Output ONE JSON object only, no markdown fences, no commentary, with exactly these keys:',
  JSON.stringify(OUTPUT_TEMPLATE),
  'telegram_summary: max 3 short sentences, plain text.',
  'For PRE_EVENT inputs you may add two optional keys: "ai_disagreement" (boolean) and "disagreement_reason" (string) when you disagree with input.deterministic.forecast_state. Never change the deterministic score, state or confidence.',
].join('\n');

function buildMessages(purpose, facts) {
  const task = {
    EVENT: 'Analyse this validated gold-relevant event cluster: what happened, why it matters for gold, the channels, the conflict between forces, market confirmation and horizon biases.',
    PRE_EVENT: 'Build the pre-event intelligence for this scheduled event: historical reaction context, current market state, the conditional pre-event bias and the three scenarios. Never state the outcome.',
    DAILY: 'Write the daily desk synthesis: regime, horizon biases, top drivers across geopolitics/politics/macro, market confirmation, upcoming events and what could change the regime.',
    TEST: 'Analyse this SIMULATED test event exactly as a real one (it is a pipeline test).',
  }[purpose] || 'Analyse the input.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `TASK: ${task}\nINPUT JSON:\n${JSON.stringify(facts)}` },
  ];
}

/** Extracts the first balanced JSON object from model text (tolerates fences/prose). */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function normaliseBias(v) {
  const t = String(v || '').toUpperCase().trim();
  if (BIAS_ENUM.includes(t)) return t;
  for (const b of BIAS_ENUM) if (t.startsWith(b)) return b;
  return null;
}

/** @returns {{ok:boolean, errors:string[], value?:object}} */
function validateSchema(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['not a JSON object'] };
  const out = {};
  // "No such driver" answered as null (live finding 2026-09-28) means NONE; everything else stays strict.
  const NULLABLE_DRIVERS = ['secondary_driver', 'counter_driver'];
  for (const f of STRING_FIELDS) {
    if (NULLABLE_DRIVERS.includes(f) && obj[f] === null) { out[f] = 'NONE'; continue; }
    if (typeof obj[f] !== 'string') { errors.push(`${f}: missing or not a string`); continue; }
    let v = obj[f].trim();
    if (MAX_LEN[f] && v.length > MAX_LEN[f]) v = `${v.slice(0, MAX_LEN[f] - 1)}…`;
    out[f] = v;
  }
  for (const f of ARRAY_FIELDS) {
    if (!Array.isArray(obj[f])) { errors.push(`${f}: missing or not an array`); continue; }
    out[f] = obj[f].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 400)).slice(0, 10);
  }
  for (const f of BIAS_FIELDS) {
    if (out[f] === undefined) continue;
    const b = normaliseBias(out[f]);
    if (!b) errors.push(`${f}: "${String(out[f]).slice(0, 30)}" not in ${BIAS_ENUM.join('/')}`);
    else out[f] = b;
  }
  const conf = Number(obj.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 100) errors.push('confidence: not a number in 0-100');
  else out.confidence = Math.round(conf);
  if (obj.ai_disagreement !== undefined) out.ai_disagreement = obj.ai_disagreement === true;
  if (typeof obj.disagreement_reason === 'string') out.disagreement_reason = obj.disagreement_reason.trim().slice(0, 500);
  if (out.summary !== undefined && out.summary.length < 20) errors.push('summary: too short');
  if (out.telegram_summary !== undefined && out.telegram_summary.length < 20) errors.push('telegram_summary: too short');
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: out };
}

// ---------------------------------------------------------------------------
// Factuality guard
// ---------------------------------------------------------------------------
const NUM_RE = /(?<![A-Za-z])[-+]?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z])[-+]?\$?\d+(?:\.\d+)?/g;

function collectFactNumbers(facts) {
  const set = new Set();
  const addNum = (n) => {
    if (!Number.isFinite(n)) return;
    const a = Math.abs(n);
    for (const dp of [0, 1, 2, 3]) set.add(String(Number(a.toFixed(dp))));
    set.add(String(a));
    // Percent <-> basis points presentation of the same fact.
    set.add(String(Number((a * 100).toFixed(1))));
    set.add(String(Number((a / 100).toFixed(4))));
  };
  const addFromString = (s) => {
    for (const m of String(s).match(NUM_RE) || []) addNum(Number(m.replace(/[$,+]/g, '')));
    // Fractions like 3-3/4
    for (const m of String(s).match(/(\d+)-(\d)\/(\d)/g) || []) {
      const [, w, a, b] = /(\d+)-(\d)\/(\d)/.exec(m);
      addNum(Number(w) + Number(a) / Number(b));
    }
  };
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') addNum(v);
    else if (typeof v === 'string') addFromString(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  return set;
}

function factualityGuard(value, facts) {
  const allowed = collectFactNumbers(facts);
  const factText = JSON.stringify(facts).toLowerCase();
  const violations = [];
  const texts = [];
  for (const f of STRING_FIELDS) if (value[f]) texts.push([f, value[f]]);
  for (const f of ARRAY_FIELDS) (value[f] || []).forEach((t, i) => texts.push([`${f}[${i}]`, t]));
  if (value.disagreement_reason) texts.push(['disagreement_reason', value.disagreement_reason]);
  for (const [field, text] of texts) {
    // Horizon/tenor labels are vocabulary, not data points.
    const cleaned = text
      .replace(/\b(?:2|5|10|30)[- ]?(?:y|yr|year)s?\b/gi, ' ')
      .replace(/\b\d+(?:\.\d+)?\s?(?:m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\b/gi, ' ')
      .replace(/\b(?:1st|2nd|3rd|\d+th)\b/gi, ' ')
      .replace(/\bQ[1-4]\b/g, ' ')
      .replace(/\b(?:G7|G20|M2|S&P ?500|PCE|CPI)\b/gi, ' ');
    for (const m of cleaned.match(NUM_RE) || []) {
      const raw = m.replace(/[$,+]/g, '');
      const n = Math.abs(Number(raw));
      if (!Number.isFinite(n)) continue;
      if (Number.isInteger(n) && n <= 10 && !/[%$]/.test(m) && !/\./.test(raw)) continue; // small counts ("3 scenarios")
      const candidates = [String(n), String(Number(n.toFixed(3)))];
      if (!candidates.some((c) => allowed.has(c))) violations.push({ field, type: 'UNSUPPORTED_NUMBER', value: m.trim() });
    }
    for (const q of text.match(/["“]([^"”]{20,})["”]/g) || []) {
      const inner = q.slice(1, -1).toLowerCase();
      if (!factText.includes(inner)) violations.push({ field, type: 'UNSUPPORTED_QUOTE', value: q.slice(0, 80) });
    }
    if (/\b(?:buy|sell|go long|go short|entry|stop[- ]loss|take[- ]profit|target price)\b/i.test(text) && /\b(?:recommend|should|consider|enter)\b/i.test(text)) {
      violations.push({ field, type: 'TRADE_INSTRUCTION', value: text.slice(0, 80) });
    }
  }
  return { ok: violations.length === 0, violations: violations.slice(0, 20) };
}

/**
 * The deterministic engine is authoritative: confidence is always the deterministic value
 * (the AI's own number is kept as ai_confidence for the record), and for pre-event forecasts
 * any AI lean that differs from the deterministic state is recorded as ai_disagreement.
 */
function enforceDeterministic(value, facts) {
  const det = (facts && facts.deterministic) || {};
  const detConf = Number(det.confidence);
  value.ai_confidence = value.confidence;
  if (Number.isFinite(detConf)) value.confidence = Math.round(detConf);
  if (det.forecast_state) {
    const aiLean = value.tactical_bias || value.short_bias;
    const declared = value.ai_disagreement === true;
    const implied = Boolean(aiLean && aiLean !== det.forecast_state && !(det.forecast_state === 'UNDETERMINED'));
    value.ai_disagreement = declared || implied;
    if (value.ai_disagreement && !value.disagreement_reason) {
      value.disagreement_reason = `AI lean ${aiLean} vs deterministic ${det.forecast_state}: ${String(value.interpretation || '').slice(0, 240)}`;
    }
    // Displayed biases stay deterministic; the AI's view is preserved separately.
    value.ai_short_bias = value.short_bias;
    value.ai_tactical_bias = value.tactical_bias;
    value.short_bias = det.forecast_state;
    value.tactical_bias = det.forecast_state;
  }
  return value.ai_confidence !== value.confidence;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/** X-RateLimit-* / Retry-After headers (present on OpenRouter 429 platform-limit responses). */
function rateLimitHeaders(headers) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const int = (x) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));
  const reset = int(h['x-ratelimit-reset']);
  return {
    limit: int(h['x-ratelimit-limit']),
    remaining: int(h['x-ratelimit-remaining']),
    // Reset is epoch milliseconds on OpenRouter; accept seconds too.
    reset: reset === null ? null : new Date(reset > 1e12 ? reset : reset * 1000).toISOString(),
    retry_after_s: int(h['retry-after']),
  };
}

/**
 * Request parameters adapted to the model (live finding 2026-09-28: a provider rejected
 * response_format with "does not support feature: structured-outputs", and reasoning tokens used up
 * the whole completion budget). response_format is sent only when the provider model list says the
 * model supports it; reasoning is disabled for the analyst unless configured otherwise.
 * @param {{response_format?:boolean}} caps   from the model list (unknown -> not sent)
 * @param {'off'|'low'} reasoning
 */
function requestParams(caps, reasoning) {
  return {
    ...(caps && caps.response_format ? { response_format: { type: 'json_object' } } : {}),
    reasoning: reasoning === 'low' ? { effort: 'low', exclude: true } : { enabled: false },
  };
}

/** Provider error text (OpenRouter error.metadata.raw) for diagnostics, redacted and short. */
function providerErrorText(body, secrets) {
  const e = body && body.error;
  if (!e) return '';
  let raw = e.metadata && e.metadata.raw;
  if (raw && typeof raw !== 'string') raw = JSON.stringify(raw);
  const msg = String(e.message || e.code || 'error');
  return redact(raw ? `${msg} | ${raw}` : msg, secrets || []).replace(/\s+/g, ' ').slice(0, 260);
}

function classifyFailure(status, body, err) {
  if (err) {
    const msg = String(err.message || err);
    if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(msg)) return 'TIMEOUT';
    return 'NETWORK_ERROR';
  }
  if (status === 429) return 'RATE_LIMITED';
  if (status === 402) return 'INSUFFICIENT_CREDITS';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 400) {
    const text = JSON.stringify(body || '');
    // "does not support feature" = a request parameter problem, not a missing model.
    if (/does not support|unsupported (?:parameter|feature)/i.test(text)) return 'BAD_REQUEST';
    return /(?:not a valid model|model not found|no endpoints found|unknown model|invalid model)/i.test(text) ? 'MODEL_UNAVAILABLE' : 'BAD_REQUEST';
  }
  if (status >= 500) return 'PROVIDER_ERROR';
  return `HTTP_${status}`;
}

/**
 * @param {object} opts
 *  - requests: [{ref, purpose, use_ai, facts, deterministic}]
 *  - models: string[]  (ordered)
 *  - apiKey: string
 *  - http: async ({url,method,headers,body,timeout}) => {statusCode, body}
 *  - timeoutMs, maxTokens, budgetRemaining, secrets (for redaction), now: () => ms
 *  - budgetReason: fallback reason when the request budget is 0 (default DAILY_BUDGET_EXHAUSTED)
 *  - tokenBudgetRemaining: null = no token cap; <= 0 -> TOKEN_BUDGET_EXHAUSTED
 *  - modelState: { [model]: { skip, status, reason } } from the model-health circuit breaker
 *  - modelCaps: { [model]: { response_format } } from the provider model list; reasoning: 'off' | 'low'
 * Per request (optional): timeout_ms, max_attempts.
 */
async function routeRequests(opts) {
  const results = [];
  const runs = [];
  let budget = opts.budgetRemaining;
  const now = opts.now || (() => Date.now());
  for (const req of opts.requests) {
    const res = { ref: req.ref, purpose: req.purpose, mode: 'DETERMINISTIC', model: null, model_rank: null, output: null, raw_output: null, attempts: [], fallback_reason: null, fallback_level: 3 };
    const tokensLeft = opts.tokenBudgetRemaining;
    const skip = !req.use_ai ? (req.skip_reason || 'NOT_ELIGIBLE') : !opts.apiKey ? 'NOT_CONFIGURED' : budget <= 0 ? (opts.budgetReason || 'DAILY_BUDGET_EXHAUSTED')
      : tokensLeft !== null && tokensLeft !== undefined && tokensLeft <= 0 ? 'TOKEN_BUDGET_EXHAUSTED' : null;
    if (skip) {
      res.fallback_reason = skip;
      res.output = req.deterministic;
      results.push(res);
      continue;
    }
    const messages = buildMessages(req.purpose, req.facts);
    let made = 0;
    const maxAttempts = Number(req.max_attempts) > 0 ? Number(req.max_attempts) : opts.models.length;
    for (let i = 0; i < opts.models.length; i++) {
      if (budget <= 0) { res.fallback_reason = opts.budgetReason || 'DAILY_BUDGET_EXHAUSTED'; break; }
      if (made >= maxAttempts) { res.fallback_reason = 'MAX_ATTEMPTS_REACHED'; break; }
      const model = opts.models[i];
      const ms = (opts.modelState || {})[model];
      if (ms && ms.skip) {
        // Circuit breaker / rate-limit backoff / model unavailable: no request is spent on it.
        res.attempts.push({ model, rank: i + 1, success: false, skipped: true, failure_reason: `SKIPPED_${ms.status}`, detail: ms.reason, latency_ms: 0, http_status: null });
        continue;
      }
      const t0 = now();
      const attempt = { purpose: req.purpose, related_ref: req.ref, provider: 'openrouter', model, model_rank: i + 1, success: false, failure_reason: null, http_status: null, latency_ms: null, prompt_tokens: null, completion_tokens: null, total_tokens: null, cost: null, reasoning_tokens: null, ratelimit: null, retry_after_s: null, validation: null, is_test: Boolean(req.is_test), at: new Date(now()).toISOString() };
      budget -= 1;
      made += 1;
      let headers = {};
      let status = null;
      let body = null;
      let err = null;
      try {
        const r = await opts.http({
          url: OPENROUTER_URL,
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Gold Intelligence n8n' },
          body: {
            model, messages, temperature: 0.2, max_tokens: opts.maxTokens,
            ...requestParams((opts.modelCaps || {})[model], opts.reasoning),
          },
          timeout: Number(req.timeout_ms) > 0 ? Number(req.timeout_ms) : opts.timeoutMs,
        });
        status = r.statusCode;
        body = r.body;
        headers = r.headers || {};
      } catch (e) {
        err = e;
      }
      attempt.latency_ms = Math.round(now() - t0);
      attempt.http_status = status;
      attempt.ratelimit = rateLimitHeaders(headers);
      attempt.retry_after_s = attempt.ratelimit.retry_after_s;
      if (err || status !== 200 || (body && body.error)) {
        const base = classifyFailure(status || (body && body.error && Number(body.error.code)) || null, body, err);
        attempt.failure_reason = body && body.error ? `${base === 'PROVIDER_ERROR' || /^HTTP_/.test(base) ? 'PROVIDER_ERROR' : base}: ${providerErrorText(body, opts.secrets)}` : base;
        if (err) attempt.failure_reason += `: ${redact(String(err.message || err), opts.secrets).slice(0, 120)}`;
      } else {
        const usage = body.usage || {};
        attempt.prompt_tokens = usage.prompt_tokens ?? null;
        attempt.completion_tokens = usage.completion_tokens ?? null;
        attempt.total_tokens = usage.total_tokens ?? null;
        attempt.cost = Number.isFinite(Number(usage.cost)) && usage.cost !== null ? Number(usage.cost) : null;
        attempt.reasoning_tokens = usage.completion_tokens_details && Number.isFinite(usage.completion_tokens_details.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : null;
        const content = body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null;
        const parsed = extractJson(typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('') : '');
        if (!parsed) {
          attempt.failure_reason = content ? 'INVALID_JSON' : `EMPTY_CONTENT${body.choices && body.choices[0] ? ` (finish_reason=${body.choices[0].finish_reason})` : ''}`;
        } else {
          const schema = validateSchema(parsed);
          if (!schema.ok) {
            attempt.failure_reason = 'SCHEMA_INVALID';
            attempt.validation = { schema_errors: schema.errors.slice(0, 12) };
          } else {
            const raw = JSON.parse(JSON.stringify(schema.value));
            const guard = factualityGuard(schema.value, req.facts);
            const capped = enforceDeterministic(schema.value, req.facts);
            attempt.validation = { schema: 'OK', factuality: guard.ok ? 'OK' : 'REJECTED', violations: guard.violations, confidence_replaced_by_deterministic: capped, ai_disagreement: Boolean(schema.value.ai_disagreement) };
            if (!guard.ok) attempt.failure_reason = 'FACTUALITY_REJECTED';
            else {
              attempt.success = true;
              res.mode = 'AI';
              res.model = model;
              res.model_rank = i + 1;
              res.fallback_level = i;
              res.output = schema.value;
              res.raw_output = raw;
            }
          }
        }
      }
      runs.push(attempt);
      res.attempts.push({ model, rank: i + 1, success: attempt.success, failure_reason: attempt.failure_reason, latency_ms: attempt.latency_ms, http_status: status, prompt_tokens: attempt.prompt_tokens, completion_tokens: attempt.completion_tokens, total_tokens: attempt.total_tokens, cost: attempt.cost, retry_after_s: attempt.retry_after_s, ratelimit: attempt.ratelimit, at: attempt.at });
      if (attempt.success) break;
    }
    if (res.mode !== 'AI') {
      res.fallback_reason = res.fallback_reason || 'ALL_MODELS_FAILED';
      res.output = req.deterministic;
    }
    results.push(res);
  }
  return { results, runs, budgetRemaining: budget };
}

module.exports = {
  buildMessages, extractJson, validateSchema, factualityGuard, enforceDeterministic, collectFactNumbers, routeRequests, classifyFailure, rateLimitHeaders,
  requestParams, providerErrorText,
  OUTPUT_TEMPLATE, BIAS_ENUM, SYSTEM_PROMPT, OPENROUTER_URL, round,
};

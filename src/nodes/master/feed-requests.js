'use strict';
// One HTTP request item per enabled news source (live), or a single bypass item (synthetic test).
const { loadConfig } = require('../../lib/config');

const ctx = $input.first().json;
const cfg = loadConfig($env);
if (ctx.run && ctx.run.is_test) {
  return [{ json: { fetch: false } }];
}
const sources = ctx.sources || [];
if (!sources.length) return [{ json: { fetch: false, note: 'no enabled news sources' } }];
return sources.map((s) => ({
  json: {
    fetch: true,
    source_id: s.id,
    url: s.url,
    user_agent: /bea\.gov/.test(s.url) ? `Mozilla/5.0 (compatible; ${cfg.http.userAgent})` : cfg.http.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  },
}));

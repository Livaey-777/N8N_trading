'use strict';
/**
 * Adapter from n8n's `this.helpers.httpRequest` to the `http({url,...}) -> {statusCode, body}`
 * contract used by the engine modules. Never throws on HTTP status; network errors throw.
 */

function makeHttp(helpers, defaults = {}) {
  return async function http({ url, method = 'GET', headers = {}, body, timeout, binary = false, qs }) {
    const res = await helpers.httpRequest({
      url,
      method,
      qs,
      headers: { 'User-Agent': defaults.userAgent || 'GoldIntel-n8n/0.1 (automated macro research bot)', Accept: binary ? '*/*' : 'application/json, text/plain, */*', ...headers },
      body,
      json: body !== undefined && !binary,
      encoding: binary ? 'arraybuffer' : undefined,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: timeout || defaults.timeoutMs || 20000,
    });
    let b = res.body;
    if (!binary && typeof b === 'string') {
      try { b = JSON.parse(b); } catch (_) { /* keep text */ }
    }
    return { statusCode: res.statusCode, body: b, headers: res.headers };
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { makeHttp, sleep };

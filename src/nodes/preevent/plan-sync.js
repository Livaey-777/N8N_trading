'use strict';
// Calendar sync plan: official schedules (BLS/BEA ICS, Fed FOMC page) + ForexFactory weekly consensus.
const { loadConfig } = require('../../lib/config');

const cfg = loadConfig($env);
const st = $input.first().json;
const mode = st.mode;
const lastSync = st.last_sync ? Date.parse(st.last_sync) : 0;
const due = mode !== 'REFRESH' || (Date.now() - lastSync) / 3600000 >= 6;
if (!due) return [{ json: { fetch: false, mode } }];
const browserish = `Mozilla/5.0 (compatible; ${cfg.http.userAgent})`;
return [
  { kind: 'bls_ics', url: 'https://www.bls.gov/schedule/news_release/bls.ics', user_agent: cfg.http.userAgent, accept: 'text/calendar, */*' },
  { kind: 'bea_ics', url: 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics', user_agent: browserish, accept: 'text/calendar, */*' },
  { kind: 'fomc_page', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', user_agent: cfg.http.userAgent, accept: 'text/html' },
  { kind: 'ff_week', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', user_agent: browserish, accept: 'application/json' },
].map((r) => ({ json: { ...r, fetch: true, mode } }));

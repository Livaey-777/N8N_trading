-- =============================================================================
-- Source registry (verified live 2026-09-27; see SOURCE_MAP.md). Idempotent.
-- Tier 1 official · Tier 2 market infrastructure / gold bodies · Tier 3 established
-- news · Tier 4 aggregators (never sole confirmation of a critical event).
-- =============================================================================
INSERT INTO sources (id, name, publisher, url, kind, tier, category_hint, poll_group, enabled, notes) VALUES
 ('fed_press_all',   'Federal Reserve — all press releases', 'Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml', 'rss', 1, 'MACRO', 'news', true, 'FOMC statements, policy, supervision'),
 ('fed_speeches',    'Federal Reserve — speeches', 'Federal Reserve', 'https://www.federalreserve.gov/feeds/speeches.xml', 'rss', 1, 'MACRO', 'news', true, NULL),
 ('ecb_press',       'ECB — press releases', 'European Central Bank', 'https://www.ecb.europa.eu/rss/press.html', 'rss', 1, 'MACRO', 'news', true, NULL),
 ('boe_news',        'Bank of England — news', 'Bank of England', 'https://www.bankofengland.co.uk/rss/news', 'rss', 1, 'MACRO', 'news', true, NULL),
 ('boj_whatsnew',    'Bank of Japan — what''s new', 'Bank of Japan', 'https://www.boj.or.jp/en/rss/whatsnew.xml', 'rss', 1, 'MACRO', 'news', true, NULL),
 ('bls_latest',      'BLS — latest releases', 'Bureau of Labor Statistics', 'https://www.bls.gov/feed/bls_latest.rss', 'rss', 1, 'MACRO', 'news', true, 'requires identifying User-Agent'),
 ('bea_releases',    'BEA — releases', 'Bureau of Economic Analysis', 'https://apps.bea.gov/rss/rss.xml', 'rss', 1, 'MACRO', 'news', true, NULL),
 ('whitehouse_news', 'White House — news', 'The White House', 'https://www.whitehouse.gov/news/feed/', 'rss', 1, 'POLITICS', 'news', true, 'executive orders, tariffs, fiscal'),
 ('ustr_press',      'USTR — press releases', 'USTR', 'https://ustr.gov/rss.xml', 'rss', 1, 'POLITICS', 'news', true, 'trade policy'),
 ('cftc_press',      'CFTC — general press releases', 'CFTC', 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', 'rss', 2, 'MARKET', 'news', true, NULL),
 ('wgc_news',        'World Gold Council — updates', 'World Gold Council', 'https://www.gold.org/rss.xml', 'rss', 2, 'GOLD', 'news', true, 'central-bank demand, ETF flows'),
 ('cnbc_top',        'CNBC — top news', 'CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html', 'rss', 3, 'GENERAL', 'news', true, NULL),
 ('cnbc_economy',    'CNBC — economy', 'CNBC', 'https://www.cnbc.com/id/20910258/device/rss/rss.html', 'rss', 3, 'MACRO', 'news', true, NULL),
 ('cnbc_world',      'CNBC — world', 'CNBC', 'https://www.cnbc.com/id/100727362/device/rss/rss.html', 'rss', 3, 'GEOPOLITICS', 'news', true, NULL),
 ('marketwatch_top', 'MarketWatch — top stories', 'MarketWatch', 'https://feeds.marketwatch.com/marketwatch/topstories/', 'rss', 3, 'MARKET', 'news', true, NULL),
 ('bbc_world',       'BBC — world', 'BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'rss', 3, 'GEOPOLITICS', 'news', true, NULL),
 ('bbc_business',    'BBC — business', 'BBC News', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'rss', 3, 'MACRO', 'news', true, NULL),
 ('aljazeera_all',   'Al Jazeera — all', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'rss', 3, 'GEOPOLITICS', 'news', true, 'Middle East coverage'),
 ('nyt_world',       'New York Times — world', 'The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'rss', 3, 'GEOPOLITICS', 'news', true, NULL),
 ('nyt_business',    'New York Times — business', 'The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', 'rss', 3, 'MACRO', 'news', true, NULL),
 ('guardian_world',  'The Guardian — world', 'The Guardian', 'https://www.theguardian.com/world/rss', 'rss', 3, 'GEOPOLITICS', 'news', true, NULL),
 ('ft_world',        'Financial Times — world', 'Financial Times', 'https://www.ft.com/world?format=rss', 'rss', 3, 'GEOPOLITICS', 'news', true, 'headlines only'),
 ('gnews_gold',      'Google News — gold price (24h)', 'Google News', 'https://news.google.com/rss/search?q=gold+price+OR+bullion+when:1d&hl=en-US&gl=US&ceid=US:en', 'rss', 4, 'GOLD', 'news', true, 'aggregator: publisher attributed from <source>'),
 ('gnews_macro',     'Google News — Fed / Treasury yields / dollar (24h)', 'Google News', 'https://news.google.com/rss/search?q=%22Federal+Reserve%22+OR+%22Treasury+yields%22+OR+%22dollar+index%22+when:1d&hl=en-US&gl=US&ceid=US:en', 'rss', 4, 'MACRO', 'news', true, 'aggregator'),
 ('gnews_geo',       'Google News — Hormuz / Red Sea / sanctions (24h)', 'Google News', 'https://news.google.com/rss/search?q=Hormuz+OR+%22Red+Sea%22+OR+sanctions+OR+tariffs+when:1d&hl=en-US&gl=US&ceid=US:en', 'rss', 4, 'GEOPOLITICS', 'news', true, 'aggregator'),
 ('synthetic_test',  'Synthetic test source (simulation only)', 'SIMULATION', 'https://simulation.gold-intel.test/', 'rss', 4, 'GEOPOLITICS', 'test', false, 'used only by the 🧪 synthetic event test; never polled')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, publisher = EXCLUDED.publisher, url = EXCLUDED.url, kind = EXCLUDED.kind, tier = EXCLUDED.tier,
  category_hint = EXCLUDED.category_hint, poll_group = EXCLUDED.poll_group, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO schema_migrations (version) VALUES ('010_sources') ON CONFLICT DO NOTHING;

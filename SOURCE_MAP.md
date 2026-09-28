# Source map

Every external input the system reads, what it feeds, and how honest the label is.
Intelligence only: nothing here connects to a broker, platform or order route.

**Labels used in every message**

| Label | Meaning |
|---|---|
| `GOLD DATA: DIRECT` | A spot XAU/USD quote (gold-api.com, or Dukascopy XAUUSD in history). |
| `GOLD DATA: PROXY` | PAXG/USDT tokenised gold (Binance). Tracks spot closely but is **not** spot XAUUSD. |
| `USD DATA: PROXY` | The ICE DXY *formula* applied to indicative FX rates. It is **never** the official ICE DXY. |
| `DATA QUALITY: GOOD / PARTIAL / DEGRADED` | Worst-of: missing/stale instruments, age of the market context, failed calendar re-sync, missing consensus, thin history. Reasons are always listed. |

A proxy is never labelled TRUE XAUUSD or TRUE DXY.

## 1. News (Master Pipeline, every `GI_NEWS_INTERVAL_MIN`)

Tier drives confidence: 1 = official / primary, 2 = specialist institution, 3 = major newsroom, 4 = aggregator.
A tier-4 item alone can never be CRITICAL; official confirmation or multi-publisher corroboration is required.

| id | Publisher | Tier | Hint | URL |
|---|---|---|---|---|
| fed_press_all | Federal Reserve | 1 | MACRO | https://www.federalreserve.gov/feeds/press_all.xml |
| fed_speeches | Federal Reserve | 1 | MACRO | https://www.federalreserve.gov/feeds/speeches.xml |
| ecb_press | European Central Bank | 1 | MACRO | https://www.ecb.europa.eu/rss/press.html |
| boe_news | Bank of England | 1 | MACRO | https://www.bankofengland.co.uk/rss/news |
| boj_whatsnew | Bank of Japan | 1 | MACRO | https://www.boj.or.jp/en/rss/whatsnew.xml |
| bls_latest | Bureau of Labor Statistics | 1 | MACRO | https://www.bls.gov/feed/bls_latest.rss |
| bea_releases | Bureau of Economic Analysis | 1 | MACRO | https://apps.bea.gov/rss/rss.xml |
| whitehouse_news | The White House | 1 | POLITICS | https://www.whitehouse.gov/news/feed/ |
| ustr_press | USTR | 1 | POLITICS | https://ustr.gov/rss.xml |
| cftc_press | CFTC | 2 | MARKET | https://www.cftc.gov/RSS/RSSGP/rssgp.xml |
| wgc_news | World Gold Council | 2 | GOLD | https://www.gold.org/rss.xml |
| cnbc_top / cnbc_economy / cnbc_world | CNBC | 3 | mixed | cnbc.com RSS (`100003114`, `20910258`, `100727362`) |
| marketwatch_top | MarketWatch | 3 | MARKET | https://feeds.marketwatch.com/marketwatch/topstories/ |
| bbc_world / bbc_business | BBC News | 3 | mixed | https://feeds.bbci.co.uk/news/{world,business}/rss.xml |
| aljazeera_all | Al Jazeera | 3 | GEOPOLITICS | https://www.aljazeera.com/xml/rss/all.xml |
| nyt_world / nyt_business | The New York Times | 3 | mixed | https://rss.nytimes.com/services/xml/rss/nyt/{World,Business}.xml |
| guardian_world | The Guardian | 3 | GEOPOLITICS | https://www.theguardian.com/world/rss |
| ft_world | Financial Times | 3 | GEOPOLITICS | https://www.ft.com/world?format=rss |
| gnews_gold / gnews_macro / gnews_geo | Google News (aggregator) | 4 | mixed | news.google.com RSS search, last 24h |

Notes
* Google News items are attributed to the **original publisher** named in the item, still capped at tier 4.
* `synthetic_test` (publisher `SIMULATION`, host `simulation.gold-intel.test`) exists only for the 🧪 test; its events are `is_test` and never mix with live events.
* Items are validated (title, link, timestamp, age ≤ `GI_MAX_ITEM_AGE_HOURS`), normalised, exact-deduplicated by hash and clustered into events (overlap coefficient with synonyms, category compatibility, 36h window).
* Sources are polled with an identifying User-Agent (`GI_HTTP_USER_AGENT`). Failures are counted per source (`sources.consecutive_failures`) and surfaced by the Health Monitor; nothing is retried aggressively.

## 2. Market context (Master Pipeline, every `GI_MARKET_INTERVAL_MIN`)

| Instrument | Source | Label | Resolution |
|---|---|---|---|
| Gold | https://api.gold-api.com/price/XAU | **DIRECT** spot quote | intraday tick per run |
| USD | https://api.coinbase.com/v2/exchange-rates?currency=USD → ICE DXY formula (EUR 57.6%, JPY 13.6%, GBP 11.9%, CAD 9.1%, SEK 4.2%, CHF 3.6%) | **PROXY** | intraday |
| 2Y / 10Y / 30Y nominal | U.S. Treasury daily par yield curve CSV (home.treasury.gov) | official | daily (fetched at most every 3h) |
| 10Y real | U.S. Treasury daily real yield curve CSV | official | daily |
| Gold COT (non-commercial net) | CFTC Socrata `6dca-aqww`, contract 088691 | official | weekly (fetched at most every 12h) |
| WTI, VIX | FRED (`DCOILWTICO`, `VIXCLS`) | official | daily — **optional**, only with `FRED_API_KEY`; otherwise shown as `NOT AVAILABLE` |

Future-stamped points (partial candles, clock skew) are dropped everywhere before a value is used.

## 3. Calendar & consensus (Pre-Event Engine, daily + every `GI_PREEVENT_REFRESH_INTERVAL_MIN`)

| Feed | URL | Used for |
|---|---|---|
| BLS release schedule (ICS) | https://www.bls.gov/schedule/news_release/bls.ics | CPI, PPI, NFP, JOLTS, claims … dates/times |
| BEA release schedule (ICS) | https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics | GDP, PCE dates/times |
| FOMC calendar page | https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | FOMC decision dates |
| Weekly calendar JSON | https://nfs.faireconomy.media/ff_calendar_thisweek.json | consensus / previous (this week only) |

* The BEA calendar and the weekly JSON reject bare bot User-Agents; they are fetched with `Mozilla/5.0 (compatible; <GI_HTTP_USER_AGENT>)`, which still identifies this system as an automated bot. No authentication or protection is bypassed.
* Reconciliation marks releases `RESCHEDULED` / `CANCELLED` / time-changed and sends a calendar notice; forecasts for cancelled releases are cancelled.
* If a re-sync fails but ≥ 2 official calendars were verified in the last 24h, forecasts continue with `DATA QUALITY: PARTIAL` and the reason; otherwise the forecast is `UNDETERMINED` (source failure).
* `consensus` is shown as `NOT AVAILABLE` when absent; a data release within 36h without consensus lowers data quality.

## 4. Actuals & post-event measurement (Post-Event Review)

| Input | Source | Label |
|---|---|---|
| Actual prints (CPI, NFP, …) | BLS Public API v1 `api.bls.gov/publicAPI/v1/timeseries/data/` (no key) | official |
| FOMC statement text | federalreserve.gov press release | official |
| Gold reaction (minutes) | Dukascopy XAUUSD `.bi5` (LZMA) when reachable, else Binance PAXGUSDT 1m | DIRECT / **PROXY** |
| USD reaction (minutes) | Dukascopy EURUSD inverted, else Binance EURUSDT inverted | PROXY |
| Yields | Treasury daily curve | official, daily resolution |

## 5. Historical reaction database (backfill, offline tool)

`node tools/backfill-history.js --from=2021-01-01 --source=auto --load`

* Event dates: official calendars (BLS/BEA ICS, FOMC page) and stored releases.
* Reactions: Dukascopy spot when reachable (preferred, `DIRECT`), else Binance PAXGUSDT / EURUSDT 1-minute (`PROXY`). The data source is stored per row and the forecast message prints `HISTORICAL REACTIONS: DIRECT` or `PROXY` accordingly.
* Dukascopy has no published API terms for bulk use and rate-limits aggressively (HTTP 503/429); the tool probes three files, caches to disk, and falls back to the proxy rather than hammering the endpoint.
* Current seed: 362 releases (NFP 68, CPI 68, PPI 68, JOLTS 68, FOMC 46, GDP 25, PCE 19), all measured with the PAXG/EURUSDT proxy from this host.

## 6. AI (OpenRouter)

See [AI_MODELS.md](AI_MODELS.md). Only compact, factual summaries of already-computed results are sent; never secrets, never raw feeds.

## 7. Telegram

See [TELEGRAM.md](TELEGRAM.md). Outbound messages and inbound commands only (long polling, no public webhook).

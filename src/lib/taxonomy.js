'use strict';
/**
 * Lexicons for classification and gold-transmission detection.
 *
 * Conventions
 *  - Patterns are lowercase regex fragments matched against normalised lowercase text
 *    with alphanumeric boundaries (see classify.compile()).
 *  - `dir` is the direction FOR GOLD: +1 bullish, -1 bearish, 0 relevance-only.
 *  - Within a channel, entries are evaluated in order and matched spans are masked,
 *    so specific phrases ("tariff pause") must precede generic ones ("tariffs").
 *  - No person names are hard-coded: roles/institutions only (office holders change).
 */

// Verb groups ------------------------------------------------------------------
const UP = "(?:rise|rises|rose|rising|risen|climb(?:s|ed|ing)?|jump(?:s|ed|ing)?|surg(?:e|es|ed|ing)|spik(?:e|es|ed|ing)|soar(?:s|ed|ing)?|rall(?:y|ies|ied|ying)|gain(?:s|ed|ing)?|advanc(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|strengthen(?:s|ed|ing)?|firm(?:s|ed|ing)?|hit(?:s|ting)? (?:a )?(?:fresh |new |record |multi-[a-z]+ |\\d+-[a-z]+ )?highs?|edg(?:e|es|ed|ing) (?:up|higher)|(?:move|moves|moved|moving|push|pushes|pushed|pushing|trade|trades|traded|trading) higher|higher|up sharply|at record|at (?:its |their |a )?(?:highest|peak)|(?:multi-[a-z]+|\d+-[a-z]+|decade|two-decade|record|all-time) highs?)";
const DOWN = "(?:fall|falls|fell|falling|fallen|drop(?:s|ped|ping)?|slid(?:e|es|ing)?|slump(?:s|ed|ing)?|tumbl(?:e|es|ed|ing)|plung(?:e|es|ed|ing)|sink(?:s|ing)?|sank|declin(?:e|es|ed|ing)|retreat(?:s|ed|ing)?|eas(?:e|es|ed|ing)|weaken(?:s|ed|ing)?|los(?:e|es|ing)|lost|dip(?:s|ped|ping)?|decreas(?:e|es|ed|ing)|slip(?:s|ped|ping)?|hit(?:s|ting)? (?:a )?(?:fresh |new |multi-[a-z]+ |\\d+-[a-z]+ )?lows?|edg(?:e|es|ed|ing) (?:down|lower)|(?:move|moves|moved|moving|push|pushes|pushed|pushing|trade|trades|traded|trading) lower|lower|down sharply|at (?:its |their |a )?lowest|(?:multi-[a-z]+|\d+-[a-z]+|decade|record) lows?)";
// Up to three intervening words, never crossing a clause connector.
const GAP = "(?:\\s+(?!(?:while|as|but|and|after|despite|though|although|amid|even|than|with|whereas|because|since)\\b)[a-z0-9'.%$&-]+){0,3}?\\s+";
const near = (subject, verb) => `(?:${subject})${GAP}${verb}`;

const DOLLAR = "(?:us |u\\.s\\. )?dollar(?: index)?|greenback|dxy";
const YIELDS = "(?:(?:us |u\\.s\\. |treasury |bond |benchmark |10-year |ten-year |2-year |two-year |30-year |long-term |short-term )+)?yields?";
const REAL_YIELDS = "real (?:yields?|rates?)|tips yields?|inflation-protected (?:securities )?yields?";
const OIL = "oil(?: prices?)?|crude(?: oil)?(?: prices?)?|brent(?: crude)?|wti|natural gas(?: prices?)?|gas prices";
const STOCKS = "stocks?|shares|equities|wall street|s&p 500|s&p|nasdaq|dow(?: jones)?|global markets|world markets|asian markets|european markets";
const GOLDWORDS = "gold(?: prices?| futures)?|spot gold|bullion|precious metals?|xau(?:usd)?";
const CBANKS = "central banks?|pboc|people's bank of china|reserve bank of india|rbi|national bank of poland|czech national bank|central bank of (?:turkey|india|china|russia|poland)|monetary authorit(?:y|ies)";

// Masks applied before matching (false-positive guards) --------------------------
const MASKS = [
  { re: '(?:trade war|trade (?:tensions?|dispute|conflict|rift|spat|fight)) (?:escalat\\w*|deepen\\w*|intensif\\w*|widen\\w*|heat\\w* up)', tag: ' xtradewarx xtradeescx ' },
  { re: 'retaliatory (?:tariffs?|duties|measures|levies|trade)|retaliat\\w* (?:with|against) (?:tariffs?|duties|levies)', tag: ' xretaltariffx ' },
  { re: "(?:trade|price|bidding|culture|talent|currency|turf|streaming|console) wars?", tag: ' xtradewarx ' },
  { re: "[a-z]+ gold (?:inc|corp|corporation|ltd|limited|fields|resources|royalt(?:y|ies)|mining|miners?|company|co)\\b[.]?|\\((?:tsx|nyse|asx|lse|nasdaq|tsxv|jse)[:.][a-z0-9.]+\\)|(?:tsx|nyse|asx|lse|tsxv|jse):[a-z0-9.]+", tag: ' xminerequityx ' },
  { re: '(?:gold|silver) (?:rate|price)s? today in|(?:22|24|18) carat|carat gold', tag: ' xlocalpricex ' },
  // "... despite a slump and tariffs": tariffs as background of a company/sector story, not a policy action.
  { re: "despite(?:\\s+[a-z0-9'-]+){0,5}?\\s+(?:and\\s+)?tariffs?", tag: ' xincidentaltariffx ' },
  { re: 'war of words', tag: ' xwordwarx ' },
  { re: '(?:heart|panic|asthma) attacks?', tag: ' xmedicalx ' },
  { re: '(?:cyber ?attacks?|hack(?:s|ed)?)', tag: ' xcyberx ' },
  { re: '(?:\\d+(?:\\.\\d+)?\\s?)?(?:multi|billion|million|trillion|thousand)-dollar', tag: ' xmoneyx ' },
  { re: '(?:\\$?\\d+(?:\\.\\d+)?\\s?(?:billion|million|trillion)?\\s)dollars', tag: ' xmoneyx ' },
  { re: 'dividend yields?|earnings yields?|yield farming', tag: ' xyieldnoisex ' },
  { re: '(?:workers?|union|labou?r|staff|dock|port|auto|nurses?|teachers?|writers?|actors?) (?:go on |on |threaten |begin |end |call off )?strikes?|strike action|on strike|general strike|hunger strike', tag: ' xlaborstrikex ' },
  { re: "(?:olympic |world )?gold medals?|won (?:a |the |two |three )?golds?|(?:olympic|world championship) gold|gold (?:cup|card|cards|star|coast|rush|glove|globe|record|status|member|members|tier|plan|standard of)|black gold|golden (?:state|globe|visa|dome|age|ticket|boot)", tag: ' xgoldnoisex ' },
  { re: 'fed up|fed into|fed by|fed through|spoon-fed|well-fed|grass-fed', tag: ' xfednoisex ' },
  { re: '(?:announces?|issues?|approv\w*|terminat\w*) (?:of )?(?:the )?(?:approval|application|enforcement actions?|termination)|enforcement actions?|approval of (?:the )?application|bank holding compan(?:y|ies)|requests? (?:public )?comment|proposals? related to|civil money penalty|consent order|supervisory (?:letter|guidance|action)', tag: ' xsupervisoryx ' },
];

// Transmission channels ---------------------------------------------------------
// weight: relevance contribution at full strength; horizons: effect profile.
const CHANNELS = {
  SAFE_HAVEN: {
    weight: 25,
    horizons: { SHORT: 1.0, TACTICAL: 0.8, SWING: 0.4, STRUCTURAL: 0.1 },
    terms: [
      // Negated de-escalation is escalation: must precede the ceasefire/peace terms.
      { re: "(?:rejects?|rejected|rejecting|refuses?|refused|dismiss(?:es|ed)?|spurns?|spurned|walks? away from|pulls? out of|abandons?|abandoned|suspends?|suspended)(?:\\s+[a-z0-9'.-]+){0,4}?\\s+(?:cease-?fires?|truces?|peace (?:deal|talks|plan|proposal|offer|agreement)|talks)", dir: 1, w: 1.2 },
      { re: '(?:cease-?fires?|truces?|peace talks|talks|negotiations) (?:collaps\\w*|break\\w* down|broke down|violat\\w*|fail\\w*|stall\\w*|shatter\\w*)', dir: 1, w: 1.2 },
      { re: 'agree(?:s|d)? to (?:a |an )?(?:ceasefire|truce|peace talks|talks)', dir: -1, w: 1.2 },
      { re: 'cease-?fires?|truce|armistice', dir: -1, w: 1.1 },
      { re: 'peace (?:deal|talks|agreement|accord|plan|treaty|process|summit)', dir: -1, w: 1.0 },
      { re: 'de-?escalat(?:e|es|ed|ing|ion)', dir: -1, w: 1.1 },
      { re: 'withdraw(?:s|n|al|ing)? (?:of )?(?:its |their )?(?:troops|forces)', dir: -1, w: 0.9 },
      { re: 'hostages? (?:freed|released|return)', dir: -1, w: 0.7 },
      { re: 'tensions? (?:ease|eases|eased|easing|cool|cools|cooled|subside)', dir: -1, w: 0.9 },
      { re: 'declar(?:e|es|ed) war|full-scale (?:war|invasion)', dir: 1, w: 1.6 },
      { re: 'nuclear (?:test|threat|strike|weapons?|escalation|attack)', dir: 1, w: 1.4 },
      { re: 'invad(?:e|es|ed|ing)|invasion', dir: 1, w: 1.4 },
      { re: 'ballistic missiles?|missile (?:strikes?|attacks?|launch(?:es)?|barrage|fire)|missiles?', dir: 1, w: 1.2 },
      { re: 'air ?strikes?|drone (?:strikes?|attacks?)|military strikes?|strikes? (?:on|against|in)', dir: 1, w: 1.2 },
      { re: 'retaliat(?:e|es|ed|ing|ion|ory)', dir: 1, w: 1.2 },
      { re: '(?:military |armed )?escalat(?:e|es|ed|ing|ion)', dir: 1, w: 1.0 },
      { re: 'bomb(?:s|ed|ing|ings)?|shell(?:ed|ing)|artillery', dir: 1, w: 1.0 },
      { re: 'attack(?:s|ed|ing)? (?:on|against)|(?:terror(?:ist)?|militant|armed) attacks?|attack(?:s|ed|ing)? (?:a |an |the )?(?:tanker|ship|vessel|base|embassy|convoy|warship|oil facility|refinery)s?', dir: 1, w: 1.0 },
      { re: 'mobili[sz](?:e|es|ed|ation)|troops? (?:deploy\\w*|massing|build-?up)|(?:deploys?|sends?) troops', dir: 1, w: 0.9 },
      { re: 'blockade|martial law|state of emergency|coup|assassinat(?:e|ed|ion)', dir: 1, w: 1.1 },
      { re: 'seiz(?:e|es|ed|ure) (?:of )?(?:a |an |the )?(?:oil |cargo )?(?:tanker|ship|vessel)s?', dir: 1, w: 1.0 },
      { re: 'shoots? down|shot down|killed in (?:an? )?(?:strike|attack)|clash(?:es|ed)', dir: 1, w: 0.8 },
      { re: '(?:geopolitical|military) (?:risks?|tensions?|conflict|uncertainty)|tensions? (?:rise|rising|escalate|flare|mount)', dir: 1, w: 0.8 },
      { re: 'safe[- ]haven (?:demand|buying|flows?|bid|appeal|assets?)|flight to (?:safety|quality)|seek(?:s|ing)? (?:safety|safe[- ]havens?|shelter)', dir: 1, w: 1.0 },
      { re: 'wars?|warfare|conflict', dir: 1, w: 0.7 },
    ],
  },
  REAL_YIELD: {
    weight: 28,
    horizons: { SHORT: 0.7, TACTICAL: 1.0, SWING: 0.9, STRUCTURAL: 0.6 },
    terms: [
      { re: near(REAL_YIELDS, DOWN), dir: 1, w: 1.3 },
      { re: near(REAL_YIELDS, UP), dir: -1, w: 1.3 },
      { re: '(?:lower|falling|declining) real (?:yields|rates)', dir: 1, w: 1.2 },
      { re: '(?:higher|rising|elevated) real (?:yields|rates)', dir: -1, w: 1.2 },
      { re: 'real (?:yields?|rates?)|tips', dir: 0, w: 0.6 },
    ],
  },
  NOMINAL_YIELD: {
    weight: 16,
    horizons: { SHORT: 0.8, TACTICAL: 0.8, SWING: 0.5, STRUCTURAL: 0.2 },
    terms: [
      { re: '(?:bond|treasury|treasuries|gilt) (?:sell-?off|rout|slump)|bonds? (?:sell off|sold off)', dir: -1, w: 1.1 },
      { re: '(?:bond|treasury|treasuries) rall(?:y|ies|ied)|bonds? rall(?:y|ies|ied)', dir: 1, w: 1.0 },
      { re: '(?:falling|sliding|declining|tumbling|lower|easing|retreating) (?:treasury |bond |us |long-term |10-year |2-year )?yields', dir: 1, w: 1.0 },
      { re: '(?:surging|soaring|rising|climbing|jumping|higher|elevated|spiking) (?:treasury |bond |us |long-term |10-year |2-year )?yields', dir: -1, w: 1.0 },
      { re: near(YIELDS, DOWN), dir: 1, w: 1.0 },
      { re: near(YIELDS, UP), dir: -1, w: 1.0 },
      { re: 'term premium', dir: 0, w: 0.5 },
      { re: 'treasury yields?|bond yields?|10-year yield|2-year yield', dir: 0, w: 0.6 },
    ],
  },
  USD: {
    weight: 22,
    horizons: { SHORT: 1.0, TACTICAL: 0.8, SWING: 0.5, STRUCTURAL: 0.3 },
    terms: [
      { re: 'de-?dollari[sz]ation', dir: 1, w: 1.0 },
      { re: "(?:weak|weaker|weakening|softer|falling) (?:us |u\\.s\\. )?dollar|dollar(?:'s)? (?:weakness|slide|slump|decline|selloff|sell-off)", dir: 1, w: 1.1 },
      { re: "(?:strong|stronger|strengthening|firmer|rising) (?:us |u\\.s\\. )?dollar|dollar(?:'s)? (?:strength|rally|surge|gains)|king dollar", dir: -1, w: 1.1 },
      { re: near(DOLLAR, DOWN), dir: 1, w: 1.0 },
      { re: near(DOLLAR, UP), dir: -1, w: 1.0 },
      { re: 'dollar index|greenback|dxy', dir: 0, w: 0.5 },
    ],
  },
  INFLATION: {
    weight: 24,
    // Horizon-split handled in transmission.js (hot = hawkish short-term, hedge long-term).
    horizons: { SHORT: 1.0, TACTICAL: 0.8, SWING: 0.3, STRUCTURAL: 0.6 },
    detect: "inflation|cpi|consumer prices?|consumer price index|pce|personal consumption expenditures|ppi|producer prices?|core prices|price pressures?|price growth|disinflation|deflation",
    terms: [
      { re: 'hotter[- ]than[- ]expected|above (?:expectations|forecasts?|estimates|consensus)|higher than (?:expected|forecast|anticipated)|more than (?:expected|forecast)|upside surprise|beat(?:s)? (?:expectations|forecasts?)', dir: 1, w: 1.3, tag: 'HOT' },
      { re: 're-?accelerat\\w*|accelerat(?:e|es|ed|ing|ion)|sticky|persistent|stubborn|heat(?:s|ed)? up|hotter|surg(?:e|es|ed|ing)|jump(?:s|ed)?|spik(?:e|es|ed)', dir: 1, w: 1.0, tag: 'HOT' },
      { re: 'remains? (?:elevated|high|above target)|elevated|too high|above (?:the )?(?:2%|two percent|target)', dir: 1, w: 0.7, tag: 'HOT' },
      { re: '(?:hits?|at|reach\\w*|climbs? to|rises? to) (?:a |its )?(?:\\d+|multi|two|three|four|five|six|seven|eight|nine|ten)[- ](?:year|month|decade) high|highest (?:level |rate |reading )?(?:since|in)', dir: 1, w: 1.1, tag: 'HOT' },
      { re: 'cooler[- ]than[- ]expected|below (?:expectations|forecasts?|estimates|consensus)|lower than (?:expected|forecast|anticipated)|less than (?:expected|forecast)|downside surprise|miss(?:es|ed)? (?:expectations|forecasts?)', dir: -1, w: 1.3, tag: 'COOL' },
      { re: 'decelerat\\w*|disinflation|cool(?:s|ed|ing|er)|soft(?:er|ens|ened|ening)|moderat(?:e|es|ed|ing)|slow(?:s|ed|ing|down)|eas(?:e|es|ed|ing)|lowest (?:since|in)', dir: -1, w: 1.0, tag: 'COOL' },
    ],
  },
  MONETARY_POLICY: {
    weight: 30,
    horizons: { SHORT: 0.9, TACTICAL: 1.0, SWING: 0.9, STRUCTURAL: 0.5 },
    terms: [
      { re: "(?:fire|fires|firing|oust|ousts|ousting|remov(?:e|es|ing|al of)|replac(?:e|es|ing)|pressur(?:e|es|ed|ing)|attack(?:s|ed|ing)?|criticis(?:e|es|ed|ing)|criticiz(?:e|es|ed|ing)|undermin(?:e|es|ed|ing)) (?:the )?(?:fed|federal reserve|central bank)(?:'s)?(?: chair(?:man|woman)?| governor| chief| board)?|(?:fed|federal reserve|central bank) independence", dir: 1, w: 1.3, tag: 'CB_INDEPENDENCE' },
      { re: 'emergency (?:rate )?cuts?', dir: 1, w: 1.5 },
      { re: '(?:rate[- ]|fed )?cut (?:bets?|expectations|hopes?|odds|pricing) (?:fade|faded|fading|pared|recede|receded|slashed|dim|dimmed|cool\\w*|eas\\w*)|pare(?:s|d)? (?:rate[- ]|fed )?cut bets', dir: -1, w: 1.2 },
      { re: '(?:rate[- ]|fed )?cut (?:bets?|expectations|hopes?|odds|pricing) (?:rise|rises|rose|grow|grows|grew|build\\w*|built|jump\\w*|increas\\w*|firm\\w*|climb\\w*|mount\\w*|strengthen\\w*)', dir: 1, w: 1.2 },
      { re: '(?:rate[- ]|fed )?hike (?:bets?|expectations|odds|pricing) (?:rise|rises|rose|grow|grows|grew|build\\w*|built|jump\\w*|increas\\w*|firm\\w*|climb\\w*|mount\\w*|strengthen\\w*)', dir: -1, w: 1.2 },
      { re: 'fewer (?:rate )?cuts|delay(?:s|ed|ing)? (?:rate )?cuts|no rush to cut|push(?:es|ed)? back (?:on|against) (?:rate )?cuts|higher for longer|restrictive (?:for longer|policy|stance)', dir: -1, w: 1.2 },
      { re: 'rate hikes?|hik(?:e|es|ed|ing) (?:interest )?rates|rais(?:e|es|ed|ing) (?:interest )?rates|tighten(?:s|ed|ing)? (?:monetary )?policy|monetary tightening|hawkish|quantitative tightening|balance sheet (?:runoff|reduction)', dir: -1, w: 1.2 },
      { re: 'rate cuts?|cut(?:s|ting)? (?:interest )?rates|lower(?:s|ed|ing)? (?:interest )?rates|slash(?:es|ed|ing)? (?:interest )?rates|eas(?:e|es|ed|ing) (?:monetary )?policy|monetary easing|dovish|quantitative easing|end(?:s|ed)? (?:quantitative )?tightening|accommodative|(?:more|faster|deeper|bigger) cuts', dir: 1, w: 1.2 },
      { re: 'pause(?:s|d)? (?:rate )?hikes|stimulus|(?:more|further|additional) easing|easing (?:cycle|bias|path)', dir: 1, w: 0.9 },
      { re: '(?:holds?|keeps?|leaves?|left|kept|held) (?:interest )?rates? (?:steady|unchanged|on hold)|on hold', dir: 0, w: 0.9 },
      { re: 'fomc|federal reserve|monetary policy|interest rates?|policy rate|fed funds', dir: 0, w: 0.7 },
    ],
  },
  FISCAL_POLICY: {
    weight: 14,
    horizons: { SHORT: 0.2, TACTICAL: 0.4, SWING: 0.7, STRUCTURAL: 1.0 },
    terms: [
      { re: 'shutdown (?:averted|ends|ended|avoided)|debt (?:ceiling|limit) (?:deal|raised|suspended|agreement)|deficits? (?:narrow\\w*|shrink\\w*|fall\\w*)|budget surplus|fiscal (?:consolidation|discipline|restraint)|spending cuts|austerity', dir: -1, w: 1.0 },
      { re: 'credit (?:rating )?downgrade|downgrad(?:e|es|ed) (?:the )?(?:us |u\\.s\\. |sovereign |government )?(?:credit|rating|debt)', dir: 1, w: 1.3 },
      { re: 'debt (?:ceiling|limit)|government shutdown|shutdown (?:looms|threat|risk|begins|deadline|fears)', dir: 1, w: 1.1 },
      { re: 'fiscal (?:crisis|concerns?|worries|risks?|dominance|slippage|deficit)|debt (?:crisis|default|worries|concerns?|burden|pile|load|spiral)|default (?:risk|fears)|national debt|unsustainable (?:debt|deficits?)', dir: 1, w: 1.1 },
      { re: 'deficits? (?:widen\\w*|swell\\w*|balloon\\w*|soar\\w*|grow\\w*|hits? record)|record deficits?', dir: 1, w: 1.1 },
      { re: 'spending (?:bill|package|plan|spree)|stimulus (?:package|checks|bill)|tax cuts?|borrowing (?:surge|needs|jump)|(?:bond|debt|treasury) issuance|refunding', dir: 1, w: 0.8 },
      { re: '(?:budget|fiscal) deficits?|fiscal policy|government spending|budget (?:bill|talks|deal)', dir: 0, w: 0.7 },
    ],
  },
  LIQUIDITY: {
    weight: 10,
    horizons: { SHORT: 0.8, TACTICAL: 0.6, SWING: 0.3, STRUCTURAL: 0.2 },
    terms: [
      { re: 'margin calls?|forced (?:selling|liquidation)|dash for cash|liquidity (?:crunch|squeeze|crisis)|deleverag(?:e|ing)|fire sale', dir: -1, w: 1.1 },
      { re: 'liquidity injection|inject(?:s|ed|ing)? liquidity|repo (?:facility|operations?)|standing repo|emergency (?:lending|liquidity|funding)|bailout|bank rescue|backstop', dir: 1, w: 1.0 },
      { re: 'liquidity', dir: 0, w: 0.5 },
    ],
  },
  RISK_SENTIMENT: {
    weight: 12,
    horizons: { SHORT: 1.0, TACTICAL: 0.7, SWING: 0.3, STRUCTURAL: 0.1 },
    terms: [
      { re: 'bank (?:failures?|collapses?|runs?)|banking (?:crisis|turmoil|stress)|contagion', dir: 1, w: 1.2 },
      { re: near(STOCKS, '(?:plung|tumbl|slump|sink|sank|crash|sell(?:s|ing)? off|slid|fall|fell|drop|rout|los)[a-z]*'), dir: 1, w: 1.0 },
      { re: 'sell-?off|market (?:turmoil|rout|crash|panic|meltdown)|risk-?off|recession (?:fears|worries|risks?|warnings?)|panic selling|turmoil', dir: 1, w: 1.0 },
      { re: near(STOCKS, '(?:rall|surg|soar|jump|climb|gain|hit record|record high)[a-z]*'), dir: -1, w: 0.8 },
      { re: 'risk-?on|risk appetite (?:returns|improves|recovers)|investor optimism', dir: -1, w: 0.7 },
    ],
  },
  CENTRAL_BANK_DEMAND: {
    weight: 30,
    horizons: { SHORT: 0.1, TACTICAL: 0.3, SWING: 0.7, STRUCTURAL: 1.0 },
    terms: [
      { re: `(?:${CBANKS})(?:\\s+[a-z0-9'.%-]+){0,4}?\\s+(?:sell|sells|sold|selling|offload\\w*|cut|cuts|reduc\\w*)(?:\\s+[a-z0-9'.%-]+){0,3}?\\s+gold`, dir: -1, w: 1.3 },
      { re: 'gold (?:reserves|holdings) (?:fall|fell|decline\\w*|drop\\w*|shrink\\w*)|central bank (?:gold )?selling|net sellers? of gold', dir: -1, w: 1.2 },
      { re: `(?:${CBANKS})(?:\\s+[a-z0-9'.%-]+){0,4}?\\s+(?:buy|buys|bought|buying|purchas\\w*|add|adds|added|adding|increas\\w*|boost\\w*|accumulat\\w*|expand\\w*|rais\\w*)(?:\\s+[a-z0-9'.%-]+){0,3}?\\s+gold`, dir: 1, w: 1.4 },
      { re: 'gold (?:reserves|holdings) (?:rise|rose|increase\\w*|grew|grow\\w*|climb\\w*|expand\\w*|jump\\w*|hit record)|central bank (?:gold )?(?:buying|purchases|demand|accumulation)|official[- ]sector (?:buying|purchases|demand)|reserve diversification|repatriat\\w* (?:its |their )?gold|record (?:central bank )?(?:gold )?purchases', dir: 1, w: 1.3 },
      { re: 'gold reserves', dir: 0, w: 0.6 },
    ],
  },
  PHYSICAL_DEMAND: {
    weight: 18,
    horizons: { SHORT: 0.1, TACTICAL: 0.4, SWING: 0.8, STRUCTURAL: 0.7 },
    terms: [
      { re: 'etf outflows|outflows from gold|gold imports? (?:fall|fell|drop\\w*|slump\\w*|declin\\w*|plunge\\w*)|import dut(?:y|ies) (?:hike|hiked|raised|increase\\w*)|weak (?:physical |retail |jewel(?:le)?ry )?demand|discounts? (?:widen\\w*|deepen\\w*)|jewel(?:le)?ry demand (?:fall|fell|weak\\w*|slump\\w*|drop\\w*)|demand (?:slumps|falls|weakens)', dir: -1, w: 1.1 },
      { re: 'gold imports? (?:rise|rose|surge\\w*|jump\\w*|climb\\w*|hit)|jewel(?:le)?ry demand (?:rise|rose|strong|surge\\w*|jump\\w*)|(?:gold )?etf (?:inflows|holdings (?:rise|rose|climb\\w*|increase\\w*|jump\\w*))|inflows into gold|bar and coin demand|coin sales (?:surge\\w*|jump\\w*|rise|rose)|strong (?:physical |retail )?(?:gold )?demand|premiums? (?:rise|rose|widen\\w*|jump\\w*)|festive demand|wedding (?:season )?demand|akshaya tritiya|dhanteras', dir: 1, w: 1.1 },
      { re: 'gold etfs?|physical demand|jewel(?:le)?ry demand|gold imports?', dir: 0, w: 0.6 },
    ],
  },
  ENERGY: {
    weight: 15,
    horizons: { SHORT: 0.8, TACTICAL: 0.7, SWING: 0.4, STRUCTURAL: 0.2 },
    terms: [
      { re: "opec\\+? (?:rais\\w*|boost\\w*|increas\\w*|hik\\w*|lift\\w*) (?:oil )?(?:output|production|supply)|oversuppl\\w*|(?:oil|supply) glut|output (?:hike|increase)", dir: -1, w: 1.0 },
      { re: near(OIL, '(?:plung|tumbl|slump|fall|fell|drop|slid|sink|sank|declin|los|retreat)[a-z]*'), dir: -1, w: 1.0 },
      { re: near(OIL, '(?:surg|jump|spik|soar|rall|climb|rise|rose|gain|hit)[a-z]*'), dir: 1, w: 1.0 },
      { re: 'supply disruptions?|(?:pipeline|refinery|oil facilit(?:y|ies)|oil ?fields?|energy infrastructure|power grid|export terminal) (?:attack\\w*|strike|strikes|hit|fire|explosion|outage)|opec\\+? (?:cuts?|cut output|production cuts?)|production cuts?|output cuts?|energy crisis', dir: 1, w: 1.1 },
      { re: 'strait of hormuz|hormuz|bab el-mandeb|red sea|suez canal|tanker (?:attack\\w*|seized|hit|struck)|shipping (?:disruptions?|attacks?|lanes? (?:closed|threatened))|houthis?', dir: 1, w: 0.8 },
      { re: 'oil prices?|crude|opec\\+?|brent|wti|energy prices', dir: 0, w: 0.6 },
    ],
  },
  TRADE_SUPPLY_SHOCK: {
    weight: 22,
    horizons: { SHORT: 0.6, TACTICAL: 0.8, SWING: 0.6, STRUCTURAL: 0.4 },
    terms: [
      { re: 'tariffs? (?:cut|cuts|removed|removal|suspended|suspension|paused|pause|exemptions?|lifted|rollback|reduced|reductions?|relief|truce|delay\\w*)|(?:lift|lifts|lifted|eas(?:e|es|ed)|remov(?:e|es|ed)) (?:the )?(?:sanctions|tariffs)|sanctions relief|trade (?:deal|agreement|truce|pact|framework|breakthrough)|trade talks (?:progress|advance|resume|succeed)', dir: -1, w: 1.1 },
      { re: '(?:gold |copper )?mines? (?:strike|closure|shutdown|halt\\w*|suspension|disruption|collapse)|mining (?:output|production) (?:fall|fell|drop\\w*|declin\\w*)|smelter (?:shutdown|closure)|xlaborstrikex(?=.{0,40}\\bmine)', dir: 1, w: 1.0 },
      { re: 'xtradeescx|xretaltariffx', dir: 1, w: 1.2 },
      { re: 'trade war|xtradewarx|retaliatory (?:tariffs|measures|duties)|export (?:bans?|controls|restrictions|curbs)|import bans?|trade (?:restrictions|barriers|tensions|dispute|conflict|curbs)|supply chain (?:disruptions?|crisis|shock)|embargo|decoupling', dir: 1, w: 1.1 },
      { re: 'tariffs?|dut(?:y|ies) on imports|levies on imports', dir: 1, w: 0.9 },
      { re: 'sanctions?|rare earths?', dir: 1, w: 0.6 },
    ],
  },
  POSITIONING: {
    weight: 8,
    horizons: { SHORT: 0.5, TACTICAL: 0.8, SWING: 0.4, STRUCTURAL: 0.1 },
    terms: [
      { re: 'short[- ]covering', dir: 1, w: 0.8 },
      { re: 'crowded (?:trade|long|positioning)|record (?:net )?longs?|stretched positioning', dir: -1, w: 0.8 },
      { re: 'cftc|net longs?|net shorts?|speculative (?:positions|longs|shorts)|managed money|hedge funds?|positioning|commitments of traders', dir: 0, w: 0.7 },
    ],
  },
  VOLATILITY: {
    weight: 6,
    horizons: { SHORT: 0.8, TACTICAL: 0.4, SWING: 0.1, STRUCTURAL: 0.0 },
    terms: [
      { re: 'vix (?:jumps?|spikes?|surges?|soars?)|volatility (?:spikes?|surges?|jumps?)|wild swings|whipsaw\\w*', dir: 0, w: 1.0 },
      { re: 'volatility|vix|implied vol', dir: 0, w: 0.6 },
    ],
  },
};

// Macro data families (map into MONETARY_POLICY / RISK_SENTIMENT with direction) ----
const LABOR = {
  detect: "payrolls?|nonfarm|non-farm|jobs report|employment (?:report|situation)|unemployment (?:rate|claims)?|jobless (?:claims|rate)|job openings|jolts|hiring|layoffs?|job (?:cuts|losses|gains|growth)|labou?r market|average hourly earnings|wage growth|adp",
  strong: "strong(?:er)? (?:jobs|payrolls|hiring|labou?r market|employment)|beat(?:s)? (?:expectations|forecasts?|estimates)|stronger[- ]than[- ]expected|above (?:expectations|forecasts?|estimates)|more than expected|robust|solid|unemployment (?:rate )?(?:falls|fell|drops|dropped|declines|declined|eases|eased)|claims (?:fall|fell|drop|dropped|decline|declined)|tight labou?r market|hiring (?:accelerates|picks up|jumps)|wages? (?:rise|rose|jump|jumped|accelerate)",
  weak: "weak(?:er)? (?:jobs|payrolls|hiring|labou?r market|employment)|miss(?:es|ed)? (?:expectations|forecasts?|estimates)|weaker[- ]than[- ]expected|below (?:expectations|forecasts?|estimates)|fewer than expected|unemployment (?:rate )?(?:rises|rose|jumps|jumped|climbs|climbed|increases|increased|ticks up|ticked up)|claims (?:rise|rose|jump|jumped|climb|climbed)|layoffs? (?:surge|rise|rose|jump)|job (?:cuts|losses)|hiring (?:slows|freezes|stalls)|labou?r market (?:cools|softens|weakens)|negative (?:payrolls|jobs)|revised (?:down|lower)",
};
const GROWTH = {
  detect: "gdp|gross domestic product|pmi|ism|purchasing managers|retail sales|industrial production|factory (?:activity|orders|output)|manufacturing (?:activity|index|sector)|services (?:activity|index|sector)|consumer (?:spending|confidence|sentiment)|economic growth|recession|econom(?:y|ies) (?:shrinks|shrank|contracts|contracted|grows|grew|expands|expanded)",
  strong: "beat(?:s)? (?:expectations|forecasts?)|stronger[- ]than[- ]expected|expan(?:d|ds|ded|ding|sion)|grow(?:s|th)? faster|accelerat\\w*|rebound\\w*|above (?:expectations|forecasts?)|robust|surg\\w*|jump\\w*",
  weak: "contract(?:s|ed|ion)|shrink(?:s|ing)?|shrank|recession|slow(?:s|ed|down|ing)|weaker|miss(?:es|ed)?|below (?:expectations|forecasts?)|declin\\w*|slump\\w*|stagflation",
};

// Institutions ------------------------------------------------------------------
const INSTITUTIONS = {
  FED: "federal reserve|fomc|the fed|fed(?:'s)?(?= (?:chair|governor|officials?|policy|policymakers|rate|rates|funds|minutes|meeting|decision|statement|president|vice chair|board|speaker|cut|cuts|hike|hikes|holds?|held|signals?|says|said|leaves?|left|keeps?|kept|raises?|lowers?|independence|pivot))|fed chair",
  ECB: "ecb|european central bank",
  BOE: "bank of england|boe",
  BOJ: "bank of japan|boj",
  PBOC: "pboc|people's bank of china",
  SNB: "swiss national bank|snb",
  OTHER_CB: "central bank|reserve bank|monetary authority",
};

// Regions -----------------------------------------------------------------------
const REGIONS = {
  MIDDLE_EAST: "iran\\w*|israel\\w*|gaza|hamas|hezbollah|lebanon|syria\\w*|yemen\\w*|houthis?|saudi\\w*|iraq\\w*|qatar\\w*|uae|emirates|tehran|jerusalem|west bank|persian gulf|gulf states|strait of hormuz|hormuz|red sea|middle east",
  RUSSIA_UKRAINE: "russia\\w*|ukrain\\w*|kremlin|kyiv|kiev|moscow|crimea|donbas|donetsk|zaporizhzhia|black sea",
  CHINA_TAIWAN: "taiwan\\w*|taipei|taiwan strait|pla navy|people's liberation army",
  US_CHINA: "(?:us|u\\.s\\.|united states) and china|china and (?:the )?(?:us|u\\.s\\.|united states)|(?:us|u\\.s\\.|washington|american)[- ]china|china[- ](?:us|u\\.s\\.)|beijing and washington|washington and beijing|sino-american",
  CHINA: "china|chinese|beijing|pboc|yuan|renminbi",
  NATO_EUROPE: "nato|european union|\\beu\\b|brussels|eurozone|euro area|germany|france|poland|baltic",
  KOREA: "north korea\\w*|pyongyang|korean peninsula",
  INDIA_PAKISTAN: "india\\w*|pakistan\\w*|kashmir",
  JAPAN: "japan\\w*|tokyo|yen",
  UK: "britain|british|united kingdom|\\buk\\b|london",
  US: "united states|\\bus\\b|u\\.s\\.|washington|white house|congress|treasury|federal reserve|fomc",
};
const MAJOR_GEO_REGIONS = new Set(['MIDDLE_EAST', 'RUSSIA_UKRAINE', 'CHINA_TAIWAN', 'US_CHINA', 'KOREA']);

// Categories --------------------------------------------------------------------
const CATEGORIES = {
  GEOPOLITICS: {
    weight: 1.0,
    re: "military|troops|missiles?|air ?strikes?|drone strikes?|war|warfare|invasion|sanctions?|nato|cease-?fire|truce|diplomat\\w*|geopolitic\\w*|hormuz|red sea|houthis?|iran|israel|gaza|hamas|hezbollah|russia|ukraine|kremlin|taiwan|north korea|pentagon|defen[cs]e ministry|nuclear|blockade|navy|warships?|armed forces|retaliat\\w*|escalat\\w*|attack(?:s|ed)?|embassy|peace (?:talks|deal)",
  },
  POLITICS: {
    weight: 0.9,
    re: "congress|senate|senators?|house of representatives|house speaker|white house|president|prime minister|parliament|elections?|ballot|campaign|republicans?|democrats?|lawmakers|legislation|bill|supreme court|impeach\\w*|cabinet|treasury secretary|administration|budget|tax(?:es|ation)?|spending|debt (?:ceiling|limit)|shutdown|tariffs?|trade policy|executive order|resign\\w*|nominat\\w*|appoint\\w*|fiscal|xtradewarx|xretaltariffx|xtradeescx",
  },
  MACRO: {
    weight: 1.2,
    re: "federal reserve|fomc|the fed|fed(?='s| chair| governor| officials?| policy| rate| cuts?| hikes?| holds?| signals?| says| minutes| meeting| decision)|central banks?|ecb|bank of england|bank of japan|pboc|interest rates?|rate (?:cut|hike|decision)s?|inflation|cpi|pce|ppi|gdp|payrolls|jobs report|unemployment|jobless|pmi|ism|retail sales|economy|economic|yields?|treasur(?:y|ies)|bonds?|dollar|recession|wages|consumer (?:spending|confidence|sentiment|prices)|housing starts|durable goods|trade balance|monetary policy|employment|labou?r market|producer prices",
  },
  GOLD: {
    weight: 1.5,
    re: `${GOLDWORDS}|gold reserves|gold etfs?|gold demand|gold mines?|gold mining|gold miners?`,
  },
  MARKET: {
    weight: 0.8,
    re: "stocks?|shares|equities|wall street|s&p|nasdaq|dow|oil prices?|crude|brent|wti|bitcoin|crypto\\w*|futures|volatility|vix|currenc(?:y|ies)|forex|yen|euro|sterling|commodit(?:y|ies)|markets?",
  },
};

// Subcategory rules: first match wins within the chosen category ------------------
const SUBCATEGORIES = [
  { cat: 'MACRO', id: 'FOMC_DECISION', all: ['FED', "decision|holds?|held|keeps? rates|kept rates|cuts? rates|raises? rates|hikes? rates|leaves? rates|left rates|statement|rate decision|basis points?|policy rate"] },
  { cat: 'MACRO', id: 'CPI', all: ['cpi|consumer prices?|consumer price index'] },
  { cat: 'MACRO', id: 'PCE', all: ['pce|personal consumption expenditures|personal income and outlays'] },
  { cat: 'MACRO', id: 'NFP', all: ['payrolls?|nonfarm|non-farm|jobs report|employment situation'] },
  { cat: 'MACRO', id: 'PPI', all: ['ppi|producer prices?|producer price index'] },
  { cat: 'MACRO', id: 'JOBLESS_CLAIMS', all: ['jobless claims|initial claims|unemployment claims'] },
  { cat: 'MACRO', id: 'JOLTS', all: ['jolts|job openings'] },
  { cat: 'MACRO', id: 'GDP', all: ['gdp|gross domestic product'] },
  { cat: 'MACRO', id: 'PMI_ISM', all: ['pmi|ism|purchasing managers'] },
  { cat: 'MACRO', id: 'RETAIL_SALES', all: ['retail sales'] },
  { cat: 'MACRO', id: 'FED_COMMUNICATION', all: ['FED'] },
  { cat: 'MACRO', id: 'ECB_POLICY', all: ['ecb|european central bank'] },
  { cat: 'MACRO', id: 'BOE_POLICY', all: ['bank of england|boe'] },
  { cat: 'MACRO', id: 'BOJ_POLICY', all: ['bank of japan|boj'] },
  { cat: 'MACRO', id: 'PBOC_POLICY', all: ["pboc|people's bank of china"] },
  { cat: 'MACRO', id: 'YIELDS_USD', all: ['yields?|treasur(?:y|ies)|dollar|greenback'] },
  { cat: 'MACRO', id: 'MACRO_OTHER', all: [] },
  { cat: 'GEOPOLITICS', id: 'DE_ESCALATION', channelDir: ['SAFE_HAVEN', -1] },
  { cat: 'GEOPOLITICS', id: 'MILITARY_ESCALATION', channelDir: ['SAFE_HAVEN', 1] },
  { cat: 'GEOPOLITICS', id: 'SHIPPING_DISRUPTION', all: ['red sea|hormuz|shipping|tanker|suez|bab el-mandeb|houthi'] },
  { cat: 'GEOPOLITICS', id: 'ENERGY_DISRUPTION', channelDir: ['ENERGY', 1] },
  { cat: 'GEOPOLITICS', id: 'SANCTIONS', all: ['sanctions?|embargo|asset freeze'] },
  { cat: 'GEOPOLITICS', id: 'TRADE_CONFLICT', all: ['tariffs?|trade war|xtradewarx|xretaltariffx|xtradeescx|export controls|trade tensions'] },
  { cat: 'GEOPOLITICS', id: 'DIPLOMACY', all: ['talks|summit|diplomat\\w*|negotiat\\w*|envoy|meeting'] },
  { cat: 'GEOPOLITICS', id: 'GEO_OTHER', all: [] },
  { cat: 'POLITICS', id: 'CB_INDEPENDENCE', channelTag: 'CB_INDEPENDENCE' },
  { cat: 'POLITICS', id: 'FISCAL', all: ['deficits?|budget|spending|debt|shutdown|debt ceiling|debt limit|fiscal|downgrade|borrowing|issuance'] },
  { cat: 'POLITICS', id: 'TRADE_POLICY', all: ['tariffs?|trade|import|export|xtradewarx|xretaltariffx|xtradeescx'] },
  { cat: 'POLITICS', id: 'TAXATION', all: ['tax(?:es|ation)?'] },
  { cat: 'POLITICS', id: 'ELECTION', all: ['elections?|vote|votes|voting|ballot|campaign|polls? (?:show|open|close)|runoff|referendum'] },
  { cat: 'POLITICS', id: 'LEADERSHIP', all: ['resign\\w*|appoint\\w*|nominat\\w*|successor|leadership|sworn in|ousted|steps down'] },
  { cat: 'POLITICS', id: 'INSTITUTIONAL', all: ['court|impeach\\w*|constitution\\w*|indict\\w*|investigation'] },
  { cat: 'POLITICS', id: 'POLITICS_OTHER', all: [] },
  { cat: 'GOLD', id: 'CB_GOLD_DEMAND', channel: 'CENTRAL_BANK_DEMAND' },
  { cat: 'GOLD', id: 'PHYSICAL_DEMAND', channel: 'PHYSICAL_DEMAND' },
  { cat: 'GOLD', id: 'GOLD_SUPPLY', all: ['mines?|mining|miners?|output|production|supply'] },
  { cat: 'GOLD', id: 'GOLD_MARKET', all: [] },
  { cat: 'MARKET', id: 'ENERGY_PRICES', channel: 'ENERGY' },
  { cat: 'MARKET', id: 'RISK_SENTIMENT', channel: 'RISK_SENTIMENT' },
  { cat: 'MARKET', id: 'FX', all: ['dollar|yen|euro|sterling|currenc(?:y|ies)|forex|yuan'] },
  { cat: 'MARKET', id: 'MARKET_OTHER', all: [] },
  { cat: 'GENERAL', id: 'GENERAL', all: [] },
];

/** Market sensitivity by subcategory (0..1): how strongly markets typically reprice. */
const MARKET_SENSITIVITY = {
  FOMC_DECISION: 1.0, CPI: 0.95, NFP: 0.95, PCE: 0.85, FED_COMMUNICATION: 0.7, PPI: 0.7, GDP: 0.7,
  RETAIL_SALES: 0.6, PMI_ISM: 0.6, JOLTS: 0.55, JOBLESS_CLAIMS: 0.5, ECB_POLICY: 0.6, BOE_POLICY: 0.5,
  BOJ_POLICY: 0.6, PBOC_POLICY: 0.55, YIELDS_USD: 0.6, MACRO_OTHER: 0.35,
  MILITARY_ESCALATION: 0.75, DE_ESCALATION: 0.65, SHIPPING_DISRUPTION: 0.65, ENERGY_DISRUPTION: 0.75,
  SANCTIONS: 0.55, TRADE_CONFLICT: 0.7, DIPLOMACY: 0.35, GEO_OTHER: 0.3,
  CB_INDEPENDENCE: 0.8, FISCAL: 0.6, TRADE_POLICY: 0.65, TAXATION: 0.35, ELECTION: 0.45,
  LEADERSHIP: 0.35, INSTITUTIONAL: 0.3, POLITICS_OTHER: 0.2,
  CB_GOLD_DEMAND: 0.6, PHYSICAL_DEMAND: 0.4, GOLD_SUPPLY: 0.35, GOLD_MARKET: 0.5,
  ENERGY_PRICES: 0.55, RISK_SENTIMENT: 0.6, FX: 0.5, MARKET_OTHER: 0.3, GENERAL: 0.2,
};

const CATEGORY_BASE_RELEVANCE = { GOLD: 25, MACRO: 20, GEOPOLITICS: 15, MARKET: 10, POLITICS: 10, GENERAL: 0 };

// Severity ------------------------------------------------------------------------
const SEVERITY = [
  { re: 'declar(?:e|es|ed) war|full-scale|nuclear|invasion|invad\\w*|mass casualt\\w*|martial law|coup|default(?:s|ed)? on|emergency (?:rate )?cut|bank (?:collapse|failure|run)|hormuz (?:closed|closure|blocked)|blockade|assassinat\\w*', level: 1.0 },
  { re: 'missiles?|air ?strikes?|strikes? (?:on|against)|attack(?:s|ed)?|retaliat\\w*|escalat\\w*|sanctions?|tariffs?|shutdown|downgrad\\w*|crisis|plung\\w*|surg\\w*|record|soar\\w*|tumbl\\w*|crash\\w*|rate (?:cut|hike)s?|cuts? rates|hikes? rates|raises? rates|hotter|cooler|unexpected\\w*|surprise', level: 0.65 },
  { re: 'talks|consider\\w*|propos\\w*|warn\\w*|mull\\w*|weigh\\w*|plans?|expects?|speech|says|said|remarks|comments|outlook|preview', level: 0.35 },
];
// Previews and outlook pieces about scheduled data are context, not events.
const PREVIEW = "week ahead|(?:leads?|kicks? off|headlines?) (?:a |the )?(?:busy |big )?week|week of (?:pce|cpi|jobs|data|earnings|fed|inflation)|what to (?:watch|expect|know)|things to watch|preview|upcoming (?:jobs|cpi|pce|inflation|fed|fomc|data|report|payrolls|decision)|ahead of (?:the |this week's |next week's |friday's |today's |tuesday's |wednesday's |thursday's )?(?:fed|fomc|jobs|payrolls|cpi|pce|inflation|data|report|release|decision|meeting)|could (?:send|push|lift|drive|trigger|spark|move|jolt|rattle)";
const HEDGES = "may|might|could|considers?|considering|mulls?|weighs?|reportedly|sources say|people familiar|rumou?rs?|unconfirmed|speculation|possible|potential|if";

module.exports = {
  UP, DOWN, GAP, near, MASKS, CHANNELS, LABOR, GROWTH, INSTITUTIONS, REGIONS, MAJOR_GEO_REGIONS,
  CATEGORIES, SUBCATEGORIES, MARKET_SENSITIVITY, CATEGORY_BASE_RELEVANCE, SEVERITY, HEDGES, PREVIEW, GOLDWORDS,
};

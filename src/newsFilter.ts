import { NewsItem } from "./types";

// Headline patterns that mark low-value content – never a genuinely material
// company development. Hard-excluded from "Market Story of the Day", the
// additional-headlines slots, "latest news" displays, and (critically) from
// ever justifying a Top Opportunity.
const EXCLUDE_PATTERNS: RegExp[] = [
  // Law-firm / class-action solicitations.
  /lead plaintiff/i,
  /securities fraud (?:lawsuit|class action)/i,
  /shareholder alert/i,
  /law firm investigat/i,
  /class action/i,
  // Shareholder / D&O suits alleging misleading statements. These are filed
  // constantly and carry no long-term signal — the same class the patterns
  // above target, phrased as a complaint write-up on a legal-trade site.
  // Deliberately scoped to "misled"-style shareholder claims so a genuine
  // enforcement action ("DOJ complaint alleges antitrust violations") is
  // still kept and scored as a regulatory development.
  /\b(?:complaint|suit|lawsuit)\b.{0,60}\b(?:misled|misleading statements?|d&os|directors and officers)\b/i,
  /deadline reminder/i,
  /lead plaintiff deadline/i,
  /investors? (?:with|who suffered) losses/i,
  /(?:reminds?|encourages?|urges?) (?:investors|shareholders)/i,
  /(?:rosen|pomerantz|bragar|glancy|kessler|schall|levi\s*&?\s*korsinsky|kahn\s*swick|bronstein)\b/i,
  // ETF mechanical distributions.
  /\betf\b.*distribution/i,
  /weekly distribution/i,
  /monthly distribution/i,
  // Small institutional-position disclosures (routine 13F-style "X boosts/
  // trims/has a $Y position" filings – dozens run daily per ticker, almost
  // never investment-relevant on their own).
  /has (?:a |an )?\$[\d.,]+\s*(?:million|billion|thousand)?\s*position in/i,
  /(?:boosts|trims|lifts|raises|lowers|grows|cuts|reduces) (?:its |their )?(?:stake|position|holdings) in/i,
  // "X is Y's Nth Largest Position" – another routine 13F-disclosure phrasing.
  /\bis\b.{0,60}\b\d+(?:st|nd|rd|th)\s+(?:largest\s+)?(?:position|holding)\b/i,
  // Passive-voice "X Shares Purchased/Sold/Bought/Acquired by Y" – same
  // routine 13F-disclosure class as the "Position Boosted by ..." pattern
  // above, just phrased around "shares" instead of "position/stake".
  /\bshares?\b.{0,40}\b(?:purchased|bought|sold|acquired)\s+by\b/i,
  // Passive-voice MarketBeat-style institutional filing headlines, e.g.
  // "$AMZN Position Boosted by Griffith & Werner Inc." / "Stake Lowered by ...".
  /\b(?:position|stake|holdings)\b.*\b(?:boosted|raised|lifted|grown|lowered|trimmed|cut|reduced|increased|decreased)\s+by\b/i,
  /acquires (?:new )?shares? (?:of|in)/i,
  /buys shares? of/i,
  /sells shares? of/i,
  /grows (?:stock )?holdings/i,
  /purchases (?:new (?:stake|position|shares) in|[\d,]+ shares of)/i,
  /\b(?:llc|lp|advisors|capital management|wealth management|asset management)\b.*\b(?:buys|sells|acquires|holds|owns|purchases|invests|makes)\b/i,
  // "X Makes New Investment in Y" – the same routine 13F class as the
  // boosts/trims patterns above, but phrased with no buy/sell verb at all,
  // so none of them matched. Leaked into Important Headlines on 2026-09-10.
  /\bmakes?\s+(?:a\s+)?new\s+(?:investment|position|stake)\s+in\b/i,
  // General 13F / institutional-holding rule. The individual phrasings above
  // were added one incident at a time ("boosts stake", "shares purchased by",
  // "makes new investment in", "takes position in", ...) and a new wording
  // leaked on essentially every run. This matches the shape they all share:
  // an ASSET-MANAGER-looking actor + a portfolio verb + a position noun.
  // Scoped to manager-style entity words (not a bare "Inc"), so a real
  // corporate deal — "Acme to acquire Beta", "Acme buys rival for $8bn" —
  // does not match: those name no manager and no position noun.
  /\b(?:llc|l\.l\.c\.|\blp\b|l\.p\.|advisors?|advisory|asset management|capital management|wealth management|investment management|partners|fund|trust|bancorp|bank|group\s+inc\.?)\b.{0,60}\b(?:takes?|acquires?|makes?|boosts?|trims?|lifts?|raises?|lowers?|cuts?|reduces?|grows?|sells?|buys?|purchases?|holds?|owns?|increases?|decreases?|invests?|adds? to)\b.{0,40}\b(?:position|stake|holdings?|shares?|investment)\b/i,
  // Fund-manager trade disclosures sized in dollars rather than shares,
  // e.g. "Cathie Wood Buys $28.1 Million Worth of Meta Stock, Dumps ...".
  // Somebody else's portfolio move is not a development at the company.
  /\b(?:buys?|sells?|dumps?|offloads?|snaps? up)\b.{0,40}\bworth of\b/i,
  // Named-manager portfolio moves, e.g. "Cathie Wood's ARK sells Alphabet
  // stock, buys Meta and Beam Therapeutics". These name real companies and
  // carry a real verb, but the event happened in somebody's fund, not at the
  // company — the reader's own thesis is unaffected by who else bought.
  /(?:'s|’s)\s+(?:ark|fund|etf|portfolio|firm)\b.{0,60}\b(?:buys?|sells?|dumps?|adds?|trims?|exits?)\b/i,
  /\bark (?:invest|investment management|funds?)\b.{0,60}\b(?:buys?|sells?|dumps?|adds?|trims?)\b/i,
  // The "rotates out of X into Y" shape: a sell and a buy of two DIFFERENT
  // names in one headline is portfolio commentary, never a company event.
  /\b(?:sells?|dumps?|offloads?|exits?)\b.{0,50}\b(?:stock|shares|position)\b.{0,20},\s*(?:buys?|adds?|snaps? up|piles? into)\b/i,
  // Routine insider sales/trades (a single small disclosed sale, not a
  // material development).
  /insider\b.*\b(?:sells?|sale|trades?)\b/i,
  /\bdirector\b.*\b(?:sells?|sale)\b/i,
  /plans? [\d,]+-share stock sale/i,
  /(?:ceo|cfo|coo|president|director|officer)\b.*\btrades?\b[\d,]+\s*shares/i,
  // Bare analyst mentions with no reasoning (maintains/reiterates a rating
  // with nothing else in the headline). A price target or explicit reasoning
  // keyword makes it substantive instead – see isSubstantiveNews below.
  /^\S+.*\b(?:maintains|reiterates)\b.*\brating\b$/i,
  // Automated "the stock moved X%" articles – algorithmically generated,
  // carry no actual reasoning even when they mention a real move.
  /^why\s+(?:is\s+)?\S+\s+stock\s+(?:is\s+)?(?:up|down|moving|rising|falling|jumping|sinking)/i,
  /\bstock\s+(?:is\s+)?(?:up|down)\s+\d+(?:\.\d+)?%/i,
  /shares?\s+(?:of\s+\S+\s+)?(?:are|is|were)\s+(?:up|down|trading)\s+\d+(?:\.\d+)?%/i,
  /\b\d+(?:\.\d+)?%\s+(?:higher|lower)\b.*\btoday\b/i,
  // Same algorithmic move-recap class, phrased as "Moved Up by N%" instead of
  // "is up N%" – this is the exact shape that leaked through as the only
  // headline of the 2026-08-30 run ("Amazon.com Inc Stock (AMZN) Moved Up by
  // 3.69% on Aug 28: A Full Analysis"), because the two patterns above
  // require "stock is up N%" or a leading "Why".
  /\bmoved?\s+(?:up|down|higher|lower)\s+by\s+\d+(?:\.\d+)?%/i,
  /\b(?:rose|fell|gained|dropped|climbed|slipped|jumped|sank)\s+(?:by\s+)?\d+(?:\.\d+)?%\s+on\s+\w{3,9}\s+\d{1,2}\b/i,
  /:\s*a full analysis\s*$/i,

  // ===== Promotional corporate PR =====
  // Awards, recognitions, celebrations and marketing announcements. These
  // name a real company and read like news, but carry no investment signal.
  //
  // Deliberately narrow so genuinely material events keep passing: an AWARD
  // is promotional, a CONTRACT or an APPROVAL is not. Every award pattern
  // below requires the word "award"/"recognition" itself to be present, so
  // "wins contract", "wins approval", "wins FDA clearance" and "wins bid"
  // are untouched.
  /\bnamed\s+(?:a|the)\s+leader\b/i,
  /\bmagic quadrant\b/i,
  /\b(?:wins?|won|receives?|earns?|takes home|garners?)\b[^.]{0,45}\baward\b/i,
  /\baward(?:ed)?\b[^.]{0,35}\b(?:partner|excellence|innovation|of the year)\b/i,
  /\b(?:partner|employer|supplier|vendor)\s+of\s+the\s+year\b/i,
  /\brecogni[sz]ed\s+(?:as|by|for|among|with)\b/i,
  /\bhonou?red\s+(?:as|by|for|with)\b/i,
  /\bcelebrat(?:es|ed|ing|ion)\b/i,
  /\bribbon[-\s]cutting\b/i,
  /\bgrand opening\b/i,
  /\b\d+(?:st|nd|rd|th)\s+anniversary\b/i,
  /\bnamed\s+(?:to|one of)\b[^.]{0,45}\b(?:best places to work|most admired|fastest[-\s]growing|top\s+\d+|100 best)\b/i,
  /\bbest places to work\b/i,
  /\bbrand ambassador\b/i,
  /\bsponsors?(?:hip|ing)?\b[^.]{0,35}\b(?:event|tournament|festival|stadium|championship|gala|charity)\b/i,
];

// Leveraged/inverse ETF and fund-of-the-underlying articles – these mention
// the company's ticker (an ETF literally tracks it) but are NOT a story
// about the company itself, they're about a derivative product. Checked
// separately from EXCLUDE_PATTERNS so isEtfOrLeveragedFundNews can also be
// used standalone (e.g. by tests) without pulling in the rest of the
// promotional/legal exclusion list.
const ETF_FUND_FAMILY_NAMES =
  /\b(graniteshares|direxion|proshares|microsectors|tuttle capital|themes etf|defiance etf|kurv|roundhill|yieldmax|tradr|volatility shares)\b/i;

export function isEtfOrLeveragedFundNews(item: NewsItem): boolean {
  const title = (item.title ?? "").toLowerCase();
  if (ETF_FUND_FAMILY_NAMES.test(title)) return true;
  const mentionsEtf = /\betf\b/.test(title);
  const mentionsLeverage =
    /\b\d+x\b/.test(title) || /\b(leveraged|inverse|daily long|daily short|bull|bear)\b/.test(title);
  return mentionsEtf && mentionsLeverage;
}

export function isPromotionalOrLegalNews(item: NewsItem): boolean {
  const title = item.title ?? "";
  // A bare "maintains/reiterates rating" headline is excluded ONLY if it
  // carries no price target or explicit reasoning – those ARE substantive.
  if (/\b(?:maintains|reiterates)\b.*\brating\b/i.test(title) && isSubstantiveNews(item)) {
    return false;
  }
  if (isEtfOrLeveragedFundNews(item)) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(title));
}

// Materiality ranking for "Market Story of the Day" (see marketStory.ts) –
// a long-term investor's rough priority order for what actually moves a
// thesis, highest-weight first: confirmed earnings/guidance and M&A carry
// far more real signal than a bare analyst price-target tweak. Used as a
// soft positive signal (prioritization boost + tie-breaking), never a hard
// requirement – a genuinely strong story outside these categories can still
// win, just without the boost.
// Ordered to match the investment-materiality priority this report is meant
// to reflect, highest first:
//   earnings/results > guidance > M&A > major contracts > regulation/legal >
//   management changes > significant analyst actions > product/strategic >
//   sector-moving developments.
// First matching category wins, so the array order IS the priority order.
export type MaterialityCategory =
  | "earnings"
  | "guidance"
  | "ma"
  | "contract"
  | "regulation"
  | "management"
  | "analystAction"
  | "productStrategic"
  | "marketImpact"
  | "none";

// Hebrew label per category – used by the Market Story renderer to say what
// KIND of development this is, and to pick a grounded "what to watch next".
export const MATERIALITY_HEBREW: Record<MaterialityCategory, string> = {
  earnings: "דוח כספי / תוצאות",
  guidance: "עדכון תחזית",
  ma: "מיזוג או רכישה",
  contract: "חוזה או שותפות מהותית",
  regulation: "רגולציה או הליך משפטי",
  management: "שינוי בהנהלה",
  analystAction: "עדכון אנליסטים",
  productStrategic: "מוצר או מהלך אסטרטגי",
  marketImpact: "תנועה רוחבית בשוק",
  none: "ידיעה כללית",
};

const MATERIALITY_PATTERNS: Array<{ category: MaterialityCategory; weight: number; patterns: RegExp[] }> = [
  {
    category: "earnings",
    weight: 0.18,
    patterns: [
      /\bearnings\b/i,
      /quarterly results|q[1-4]\s*results|full[-\s]year results/i,
      /\breports?\s+(?:record\s+)?(?:q[1-4]|quarterly|fourth|third|second|first)\b/i,
      /\b(?:beats?|misses?|tops?)\b.{0,25}\b(?:estimates?|expectations?|consensus)\b/i,
      /\brevenue\s+(?:rose|fell|grew|declined|up|down)\b/i,
    ],
  },
  {
    category: "guidance",
    weight: 0.17,
    patterns: [
      /\bguidance\b/i,
      /(?:raises?|cuts?|lowers?|lifts?|trims?|reaffirms?)\s+(?:full-year\s+|fy\s*)?(?:outlook|forecast)/i,
      /\boutlook\b.{0,20}\b(?:raised|cut|lowered|reaffirmed)\b/i,
    ],
  },
  {
    category: "ma",
    weight: 0.16,
    patterns: [
      /acqui(?:res|sition|ring)|merger|to acquire|to be acquired|buyout|takeover bid|tender offer/i,
      // An all-cash deal is often phrased plainly: "buys rival chipmaker for
      // $8 billion". The price tag is what separates this from the routine
      // fund-purchase headlines excluded above.
      /\bbuys?\b.{0,45}\bfor\s+\$[\d.,]+\s*(?:billion|million|bn)\b/i,
    ],
  },
  {
    category: "contract",
    weight: 0.14,
    patterns: [
      /\b(?:wins?|won|secures?|awarded)\b.{0,30}\b(?:contract|order|bid|tender)\b/i,
      /\bcontract\b|\blicensing agreement\b|\bsupply agreement\b/i,
      /\b(?:strategic )?partnership\b|\bdeal with\b|\bjoint venture\b|\bpartners with\b|\bteams up with\b/i,
    ],
  },
  {
    category: "regulation",
    weight: 0.12,
    patterns: [
      /regulat(?:ion|or|ory)/i,
      /antitrust|monopoly probe/i,
      /\bfda\b.{0,20}\b(?:approv|clearance|reject)/i,
      /sec (?:approves|charges|investigation)/i,
      /\b(?:lawsuit|court ruling|settlement|injunction|subpoena)\b/i,
      // An enforcement body opening a case is a material legal development
      // even when the headline never says "antitrust" or "regulatory" –
      // "DOJ opens investigation into X" previously scored as generic news.
      /\b(?:doj|department of justice|ftc|european commission|eu regulators?)\b/i,
      /\b(?:opens?|opened|launch(?:es|ed)?)\s+(?:an?\s+|a formal\s+)?(?:investigation|probe|inquiry)\b/i,
      /\b(?:fined|penalty|penalties|sanctions?)\b.{0,30}\b(?:million|billion|\$)/i,
    ],
  },
  {
    category: "management",
    weight: 0.1,
    patterns: [
      /\b(?:ceo|cfo|coo|cto|chief executive|chief financial|chairman)\b.{0,40}(?:appoint|steps? down|resign|named|departs?|replac|succeed)/i,
      /\bnames?\s+new\s+(?:ceo|cfo|coo|president|chief)/i,
    ],
  },
  {
    category: "analystAction",
    weight: 0.08,
    patterns: [/upgrade|downgrade|price target|initiates coverage|\bre-?rates?\b/i],
  },
  {
    category: "productStrategic",
    weight: 0.07,
    patterns: [
      // Plain "launches <thing>" counts – regulation is matched earlier in
      // this list, so "launches an investigation" still resolves as a legal
      // development rather than a product one.
      /product launch|\blaunch(?:es|ed|ing)\b|unveils|announces new|recalls?\b|discontinu/i,
      /restructur|layoffs|spin[-\s]?off|divest/i,
      /\bsells?\s+(?:its|their)\b.{0,35}\b(?:division|unit|business|segment|arm)\b/i,
      /\bbuyback\b|\bbuys?\s+back\b|\bshare repurchase\b|\bdividend\s+(?:increase|hike|cut)\b/i,
    ],
  },
  {
    category: "marketImpact",
    weight: 0.05,
    patterns: [/\bmarket\s+(?:rally|selloff|sell-off)\b/i, /\bstocks?\s+(?:rally|surge|tumble|sink|plunge)\b/i],
  },
];

export function materiality(item: NewsItem): { category: MaterialityCategory; weight: number } {
  const title = item.title ?? "";
  for (const m of MATERIALITY_PATTERNS) {
    if (m.patterns.some((re) => re.test(title))) return { category: m.category, weight: m.weight };
  }
  return { category: "none", weight: 0 };
}

export function isSubstantiveNews(item: NewsItem): boolean {
  return materiality(item).weight > 0;
}

// ===== Source quality =====
//
// Where a headline came from is a real ranking signal, not decoration: the
// same nominal event carries different reliability depending on whether an
// established newsroom reported it or the company's own PR wire distributed
// it. Used as a weighted scoring FACTOR (see marketStory.ts's scoreNews),
// never a hard exclude – a press release about a genuine acquisition is
// still real news, it just should not outrank the same story from Reuters.
export type SourceTier = "tier1" | "quality" | "neutral" | "promotional";

const TIER1_SOURCES =
  /\b(reuters|bloomberg|wall street journal|wsj|financial times|\bft\.com\b|cnbc|barron'?s|associated press|ap news|marketwatch|the economist|nikkei|dow jones)\b/i;

const QUALITY_SOURCES =
  /\b(yahoo finance|forbes|business insider|axios|fortune|investor'?s business daily|techcrunch|the information|the verge|cnn business|npr|bbc)\b/i;

// Press-release wires and automated aggregators. A story reaching us only
// through one of these is company-controlled or machine-generated copy.
const PROMOTIONAL_SOURCES =
  /\b(business ?wire|pr ?newswire|globe ?newswire|accesswire|newsfile|ein ?press ?wire|ein news|marketbeat|tradingkey|stocktwits|zacks|simply wall st|newsbtc|investing\.com autopilot)\b/i;

// A press-release URL is as strong a signal as the source name – publishers
// syndicate PR under their own brand on a dedicated path.
const PRESS_RELEASE_URL = /\/(?:press-?releases?|news-?releases?|pressrelease)\//i;

const TIER_SCORES: Record<SourceTier, number> = {
  tier1: 1,
  quality: 0.75,
  neutral: 0.45,
  promotional: 0.1,
};

export function sourceTier(item: NewsItem): SourceTier {
  const source = item.source ?? "";
  const url = item.url ?? "";
  if (PROMOTIONAL_SOURCES.test(source) || PRESS_RELEASE_URL.test(url)) return "promotional";
  if (TIER1_SOURCES.test(source)) return "tier1";
  if (QUALITY_SOURCES.test(source)) return "quality";
  return "neutral";
}

// 0–1 quality factor for the given item's source.
export function sourceQualityScore(item: NewsItem): number {
  return TIER_SCORES[sourceTier(item)];
}

// Legal-entity suffixes stripped off a company's display name to get its
// recognizable "stem" for headline matching – e.g. "Amazon.com, Inc." ->
// "amazon", "NVIDIA Corporation" -> "nvidia", "Alphabet Inc Class A" ->
// "alphabet".
const LEGAL_SUFFIX_RE =
  /\b(inc|incorporated|corp|corporation|co|company|ltd|plc|group|holdings|technologies|class\s*[a-z])\b\.?/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameStem(companyName: string | undefined): string {
  if (!companyName) return "";
  return companyName.replace(LEGAL_SUFFIX_RE, "").trim().split(/[\s,]+/)[0] ?? "";
}

// A ticker being tagged "relevant" by the news provider is not the same as
// an article actually being ABOUT that company – provider relevance tagging
// also catches leveraged-ETF products, sector round-ups, and articles about
// a different company that merely mentions the ticker in passing. Require
// the ticker (as "$TICKER" or a standalone word) or the company's
// recognizable name stem to actually appear in the headline. This is a
// heuristic, not a semantic understanding of the article – but real
// financial-news headlines for genuine company coverage overwhelmingly name
// the company or ticker, so it reliably catches off-topic attribution
// without discarding real stories.
export function isDirectlyAboutCompany(
  ticker: string,
  companyName: string | undefined,
  item: NewsItem
): boolean {
  const title = (item.title ?? "").toLowerCase();
  if (!title) return false;
  const t = ticker.toLowerCase();
  if (title.includes(`$${t}`)) return true;
  if (new RegExp(`\\b${escapeRegExp(t)}\\b`, "i").test(title)) return true;
  const stem = nameStem(companyName).toLowerCase();
  if (stem.length >= 3 && title.includes(stem)) return true;
  return false;
}

// First relevant (non-promotional) item, preserving the caller's ordering.
export function pickRelevantNews(news: NewsItem[]): NewsItem | undefined {
  return news.find((n) => !isPromotionalOrLegalNews(n));
}

// Up to N relevant, distinct (non-promotional) items – used for the
// additional-headlines slots alongside the Market Story hero.
export function pickRelevantNewsMany(news: NewsItem[], n: number): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of news) {
    if (isPromotionalOrLegalNews(item)) continue;
    const key = item.url || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

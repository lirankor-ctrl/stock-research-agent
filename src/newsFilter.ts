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
  /\b(?:llc|lp|advisors|capital management|wealth management|asset management)\b.*\b(?:buys|sells|acquires|holds|owns|purchases)\b/i,
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
export type MaterialityCategory =
  | "earningsGuidance"
  | "ma"
  | "regulation"
  | "contract"
  | "productEvent"
  | "strategic"
  | "analystAction"
  | "marketImpact"
  | "none";

const MATERIALITY_PATTERNS: Array<{ category: MaterialityCategory; weight: number; patterns: RegExp[] }> = [
  {
    category: "earningsGuidance",
    weight: 0.16,
    patterns: [/earnings|quarterly results|q[1-4]\s*results/i, /guidance/i, /(?:raises?|cuts?|lowers?)\s+(?:full-year\s+|fy\s*)?(?:outlook|guidance|forecast)/i],
  },
  {
    category: "ma",
    weight: 0.15,
    patterns: [/acqui(?:res|sition)|merger|to acquire|to be acquired|buyout|takeover bid/i],
  },
  {
    category: "regulation",
    weight: 0.13,
    patterns: [/regulat(?:ion|or|ory)/i, /antitrust/i, /fda approv/i, /sec (?:approves|charges|investigation)/i],
  },
  {
    category: "contract",
    weight: 0.11,
    patterns: [/contract|partnership|deal with|licensing agreement/i],
  },
  {
    category: "productEvent",
    weight: 0.1,
    patterns: [/product launch|unveils|announces new|recalls?\b|discontinu/i],
  },
  {
    category: "strategic",
    weight: 0.09,
    patterns: [/restructur|layoffs|spin[- ]?off/i, /\b(ceo|cfo|chief executive)\b.*(?:appoint|step down|resign|name)/i],
  },
  {
    category: "analystAction",
    weight: 0.06,
    patterns: [/upgrade|downgrade|price target|initiates coverage/i],
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

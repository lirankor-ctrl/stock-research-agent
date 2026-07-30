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
];

export function isPromotionalOrLegalNews(item: NewsItem): boolean {
  const title = item.title ?? "";
  // A bare "maintains/reiterates rating" headline is excluded ONLY if it
  // carries no price target or explicit reasoning – those ARE substantive.
  if (/\b(?:maintains|reiterates)\b.*\brating\b/i.test(title) && isSubstantiveNews(item)) {
    return false;
  }
  return EXCLUDE_PATTERNS.some((re) => re.test(title));
}

// Substantive categories a long-term investor actually cares about – used as
// a soft positive signal (prioritization) and to rescue analyst headlines
// that do carry real reasoning.
const SUBSTANTIVE_PATTERNS: RegExp[] = [
  /earnings|quarterly results|q[1-4]\s*results/i,
  /guidance/i,
  /product launch|unveils|announces new/i,
  /regulat(?:ion|or|ory)/i,
  /acqui(?:res|sition)|merger|to acquire/i,
  /contract|partnership|deal with/i,
  /\b(ceo|cfo|chief executive)\b.*(?:appoint|step down|resign|name)/i,
  /upgrade|downgrade|price target|initiates coverage/i,
];

export function isSubstantiveNews(item: NewsItem): boolean {
  const title = item.title ?? "";
  return SUBSTANTIVE_PATTERNS.some((re) => re.test(title));
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

# stock-agent

סוכן מחקר מניות מקומי בסגנון משקיע מקצועי. עובד אמין על ה-**Free Tier** של Alpha Vantage:
מטמין נתונים מקומית, מצמצם קריאות API למינימום, וממשיך לעבוד גם כשמגיעים למגבלת הקריאות.

> ⚠️ למטרות מחקר ולמידה בלבד. אין זה ייעוץ השקעות.

---

## דרישות

- Node.js 18+
- מפתח API חינמי: <https://www.alphavantage.co/support/#api-key>

## התקנה

```bash
npm install
```

## הגדרת מפתח API

צור `.env`:
```env
ALPHA_VANTAGE_API_KEY=your_free_api_key_here
```

אופציונלי:
```env
STOCK_AGENT_ENRICH_TOP=3       # כמה מניות להעשיר עם פרופיל + חדשות (ברירת מחדל 3)
STOCK_AGENT_DELAY_MS=13000     # השהיה בין קריאות API חיות (5/דקה ב-Free Tier)
```

## הרצה

```bash
npm run dev
# או
npm run report
```

הדוח: `reports/daily-stock-report.md`

---

## תקציב קריאות API

| ריצה | קריאות נדרשות | הערה |
|------|----------------|------|
| ראשונה ביום | **7 max** (1 movers + 3×2 enrichment) | תוך מגבלת 25/יום |
| תוך 12 שעות | **0** | כל מה שצריך כבר במטמון |
| 12–24 שעות אחרי | **1** (movers בלבד) | פרופיל/חדשות עדיין במטמון |
| מעל 24 שעות | **7 max** | רענון מלא |

→ הסוכן **לא ייכשל** גם אם המכסה היומית נגמרה. הוא ישלוף נתונים מהמטמון (גם stale עד 7 ימים) ויסמן בבירור מה live, מה cached, ומה unavailable.

## מבנה הפרויקט

```
stock-agent/
├── src/
│   ├── index.ts             # אורקסטרציה עמידה לכשלים
│   ├── alphaVantage.ts      # שכבת API + זיהוי RateLimitError
│   ├── cache.ts             # מטמון JSON עם TTL ו-stale-fallback
│   ├── dataSources.ts       # cache-first wrapper לכל endpoint
│   ├── filters.ts           # סינון פני / OTC / מחיר / בורסה
│   ├── sectors.ts           # זיהוי טכנולוגיה / AI / סייבר / סמיקונדקטור
│   ├── ranker.ts            # סינון ראשוני + ציון מקדים
│   ├── enricher.ts          # העשרת Top 3 + skeleton לשאר
│   ├── scorer.ts            # ציון 1–10 (5 מימדים)
│   ├── explainer.ts         # הסבר עברי "למה המניה זזה"
│   ├── reportGenerator.ts   # דוח עם תגי live/cached/unavailable
│   └── types.ts             # TypeScript types
├── cache/                   # נוצר אוטומטית – מטמון JSON (ב-.gitignore)
├── reports/                 # נוצר אוטומטית
├── .env / .env.example
└── package.json / tsconfig.json
```

## אסטרטגיית מטמון (Cache-First)

לכל קריאה ל-API:
1. **קריאת מטמון טרי** (movers: 12h · profile/news: 24h) → אם יש, השתמש בו.
2. **קריאה חיה ל-API** → אם הצליחה, שמור במטמון והחזר.
3. **קריאה למטמון stale** (עד 7 ימים) → fallback אם ה-API נכשל / חסום.
4. **unavailable** → אם אפילו מטמון ישן לא קיים, סימון בדוח ולא קריסה.

## תגי מקור בדוח

כל סקציה בדוח מתויגת:
- 🟢 **live** – נתון טרי מ-Alpha Vantage עכשיו
- 🟡 **cached (~Xh)** – נטען מהמטמון, עם גיל בשעות
- 🔴 **unavailable** – אין נתון, גם לא במטמון

## איך הציון 1–10 עובד

| מימד | משקל |
|------|------|
| תנועת מחיר | 25% |
| מחזור מסחר | 15% |
| איכות חדשות | 25% |
| איכות חברה | 25% |
| שווי שוק | 10% |

## מבנה הדוח (8 חלקים)

1. **Market Summary** – סקירת שוק (live/cached)
2. **Top 3 Opportunities** – פירוט מלא + הסבר עברי + חדשות
3. **Top Movers** – עולים בולטים (מבוסס נתוני movers בלבד)
4. **Negative Movers** – יורדים בולטים
5. **Most Active Stocks** – הכי פעילים במחזור
6. **Key News** – חדשות מרכזיות
7. **Risks** – סיכונים ומגבלות הדוח
8. **Disclaimer** – הצהרת אחריות

## הצהרת אחריות

הכלי נועד למחקר ולמידה בלבד. **אין לראות בנתונים ייעוץ השקעות.**
מסחר במניות כרוך בסיכון לאובדן ההון. כל החלטה – על אחריותך בלבד.

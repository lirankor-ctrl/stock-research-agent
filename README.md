# stock-agent

סוכן מחקר מניות מקומי בסגנון משקיע מקצועי.
מושך נתונים מ-**Alpha Vantage** (תוכנית חינמית), מסנן פני / OTC, מעשיר עם פרופיל חברה וחדשות,
מדרג עם ציון 1–10, ומפיק דוח Markdown בעברית תחת `reports/daily-stock-report.md`.

> ⚠️ למטרות מחקר ולמידה בלבד. אין זה ייעוץ השקעות.

---

## דרישות

- Node.js 18+
- מפתח API חינמי מ-Alpha Vantage: <https://www.alphavantage.co/support/#api-key>

## התקנה

```bash
npm install
```

## הגדרת מפתח API

צור `.env` בתיקיית הפרויקט (בהשראת `.env.example`):

```env
ALPHA_VANTAGE_API_KEY=your_free_api_key_here
```

אופציונלי:
```env
STOCK_AGENT_MAX_ENRICH=10      # כמה מניות להעשיר עם פרופיל + חדשות (ברירת מחדל 10)
STOCK_AGENT_DELAY_MS=13000     # השהיה בין קריאות API (חינמי = 5/דקה)
```

## הרצה

```bash
npm run dev
# או
npm run report
```

הדוח יישמר ב-`reports/daily-stock-report.md`.

> ⏱ ההרצה לוקחת מספר דקות בגלל מגבלת ה-Free Tier (5 קריאות לדקה).
> כל מניה דורשת 2 קריאות API (פרופיל + חדשות), לכן 10 מניות = ~4–5 דקות.

## מבנה הפרויקט

```
stock-agent/
├── src/
│   ├── index.ts             # אורקסטרציה: fetch → filter → enrich → score → report
│   ├── alphaVantage.ts      # שכבת API: TOP_GAINERS_LOSERS / OVERVIEW / NEWS_SENTIMENT
│   ├── filters.ts           # סינון פני / OTC / מתחת ל-$5 + סינון בורסה
│   ├── sectors.ts           # זיהוי טכנולוגיה / AI / סייבר / סמיקונדקטור
│   ├── ranker.ts            # סינון ראשוני + Pre-Score מהיר
│   ├── enricher.ts          # קריאות API מעשירות (Rate-limit safe)
│   ├── scorer.ts            # ציון 1–10 (5 מימדים)
│   ├── explainer.ts         # הסבר עברי "למה המניה זזה" על בסיס החדשות
│   ├── reportGenerator.ts   # בניית דוח Markdown ב-8 חלקים
│   └── types.ts             # TypeScript types
├── reports/                 # נוצר בריצה הראשונה
├── .env / .env.example
├── package.json / tsconfig.json
└── README.md
```

## איך הציון 1–10 עובד

| מימד | משקל |
|------|------|
| תנועת מחיר (price move) | 25% |
| מחזור מסחר (volume) | 15% |
| איכות חדשות (sentiment + relevance) | 25% |
| איכות חברה (סקטור + שווי שוק + PE) | 25% |
| שווי שוק (market cap) | 10% |

הציון הסופי הוא בין 1.0 ל-10.0.

## פילטרים מובנים

- מחיר מתחת ל-**$5** → מסונן.
- חשד ל-OTC (טיקרים בני 5+ אותיות שמסתיימים ב-F/Y/Q, או סופיות `.PK`/`.OB`) → מסונן.
- אחרי שליפת פרופיל: חברות שלא ב-NASDAQ / NYSE / AMEX → מסוננות.
- חברות בטכנולוגיה / AI / סייבר / סמיקונדקטור / צמיחה → מקבלות בונוס בציון.

## מבנה הדוח (8 חלקים)

1. **Market Summary** – סקירת שוק מספרית
2. **Top 3 Opportunities** – הזדמנויות מובילות בפירוט מלא
3. **Top Movers** – עולים בולטים
4. **Negative Movers** – יורדים בולטים
5. **Most Active Stocks** – הכי פעילים במחזור
6. **Key News** – חדשות מרכזיות מדורגות לפי רלוונטיות
7. **Risks** – סיכונים ומגבלות של הדוח
8. **Disclaimer** – הצהרת אחריות

## הצהרת אחריות

הכלי נועד למחקר ולמידה בלבד. **אין לראות בנתונים, בדירוגים או בכל תוכן בדוח – ייעוץ השקעות.**
מסחר במניות כרוך בסיכון לאובדן ההון. כל החלטה – על אחריותך בלבד.

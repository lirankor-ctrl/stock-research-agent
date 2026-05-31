# stock-agent

סוכן מחקר מניות מקומי בסגנון משקיע מקצועי, עם:
- מטמון מקומי כדי לעבוד בתוך מגבלות ה-Free Tier של Alpha Vantage.
- דוח מסוגנן ב-Markdown + HTML (RTL עברית).
- שליחה אוטומטית במייל כל יום מסחר דרך GitHub Actions.

> ⚠️ למטרות מחקר ולמידה בלבד. אין זה ייעוץ השקעות.

---

## דרישות

- Node.js 18+
- מפתח Alpha Vantage חינמי: <https://www.alphavantage.co/support/#api-key>
- (לשליחת מייל) חשבון SMTP – למשל Gmail עם App Password.

## התקנה

```bash
npm install
```

## הגדרת `.env` (לבדיקות מקומיות)

צור קובץ `.env` בתיקיית הפרויקט (בהשראת `.env.example`):

```env
ALPHA_VANTAGE_API_KEY=your_free_api_key_here

# רק אם רוצים להריץ email-report מקומי:
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=465
EMAIL_USER=you@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM="Stock Agent <you@gmail.com>"
EMAIL_TO=you@gmail.com
```

> 🔒 הקובץ `.env` נמצא ב-`.gitignore` ולא יועלה ל-Git.
> ב-Gmail: צריך להפעיל 2FA וליצור App Password ב-<https://myaccount.google.com/apppasswords>.

---

## פקודות

| פקודה | מה היא עושה |
|-------|--------------|
| `npm run report` | מייצרת דוח (Markdown + HTML) לתיקייה `reports/`. **לא** שולחת מייל. |
| `npm run dev` | זהה ל-`report` – שימושי לפיתוח. |
| `npm run email-report` | מייצרת דוח **וגם** שולחת אותו במייל עם 2 הקבצים מצורפים. |
| `npm run build` | מהדרת ל-`dist/`. |

### בדיקה מקומית של המייל

```bash
npm run email-report
```

תראה בטרמינל:
- שלבי יצירת הדוח (`📡 / 🧹 / 🔬 / 📝`)
- אישור שליחת המייל (`✉️ Email sent. messageId=...`)

אם יש שגיאת SMTP, ההודעה תהיה ברורה (חיבור / אימות / כתובת לא תקינה).
הקבצים בכל מקרה יישמרו ב-`reports/` גם אם השליחה נכשלה.

---

## תזמון אוטומטי דרך GitHub Actions

הקובץ `.github/workflows/daily-stock-report.yml` מגדיר ריצה אוטומטית.

### לוח זמנים

- **Cron:** `0 12 * * 1-5` → **12:00 UTC** בימים ב'–ו'.
- שעון ישראל:
  - חורף (UTC+2): **14:00**
  - קיץ (UTC+3): **15:00**
- אפשר להריץ גם ידנית מ-`workflow_dispatch`.

> ℹ️ GitHub עלול לעכב ריצות מתוזמנות בכמה דקות בעומס.

### הוספת GitHub Secrets

ב-GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

הוסף את הסודות הבאים (אותם שמות בדיוק):

| Secret | דוגמה |
|--------|--------|
| `ALPHA_VANTAGE_API_KEY` | המפתח החינמי שלך |
| `EMAIL_HOST` | `smtp.gmail.com` |
| `EMAIL_PORT` | `465` |
| `EMAIL_USER` | `you@gmail.com` |
| `EMAIL_PASS` | App Password של Gmail |
| `EMAIL_FROM` | `Stock Agent <you@gmail.com>` |
| `EMAIL_TO` | `you@gmail.com` |

### הרצה ידנית מ-GitHub

1. עבור ל-**Actions** ב-Repo שלך.
2. בחר את `Daily Stock Report` בצד שמאל.
3. לחץ **Run workflow** (כפתור ימני למעלה) → **Run workflow**.
4. בסיום, הקבצים זמינים גם כ-Artifacts (`daily-stock-report`) ל-14 ימים.

---

## מבנה הפרויקט

```
stock-agent/
├── .github/workflows/
│   └── daily-stock-report.yml   # תזמון אוטומטי
├── src/
│   ├── index.ts                 # CLI ליצירת דוח בלבד
│   ├── emailReport.ts           # CLI ליצירת דוח + שליחה במייל
│   ├── pipeline.ts              # runReport() – לוגיקת הצינור המרכזית
│   ├── email.ts                 # שליחת מייל דרך Nodemailer
│   ├── alphaVantage.ts          # שכבת API + RateLimitError
│   ├── cache.ts                 # מטמון JSON עם TTL
│   ├── dataSources.ts           # cache-first wrappers
│   ├── filters.ts / sectors.ts  # סינון וזיהוי סקטור
│   ├── ranker.ts                # סינון ראשוני + Pre-Score
│   ├── enricher.ts              # העשרת Top 3
│   ├── scorer.ts                # ציון 1–10
│   ├── explainer.ts             # הסברי עברית
│   ├── marketMood.ts            # זיהוי מצב שוק
│   ├── reportGenerator.ts       # דוח Markdown
│   ├── htmlReportGenerator.ts   # דוח HTML
│   └── types.ts
├── cache/                       # אוטומטי, ב-.gitignore
├── reports/                     # אוטומטי
├── .env / .env.example
└── package.json / tsconfig.json
```

## תקציב קריאות API

| ריצה | קריאות נדרשות |
|------|----------------|
| ראשונה ביום | **7 max** (1 movers + 3×2 enrichment) |
| תוך 12 שעות | **0** (הכל מהמטמון) |
| 12–24 שעות אחרי | **1** (movers בלבד) |
| מעל 24 שעות | **7 max** |

ה-Free Tier של Alpha Vantage = **25 קריאות/יום**, **5 קריאות/דקה**.

## עקרונות

- ✅ **אין hardcoding של מפתחות API או סיסמאות** – הכול דרך `.env` או GitHub Secrets.
- ✅ **הסוכן לא קורס** מ-rate limit – fallback למטמון, ואז סימון "unavailable".
- ✅ **שליחת המייל כושלת בנפרד** מהדוח עצמו – הקבצים תמיד נשמרים.

## הצהרת אחריות

הכלי נועד למחקר ולמידה בלבד. **אין לראות בנתונים ייעוץ השקעות.**
מסחר במניות כרוך בסיכון לאובדן ההון – כל החלטה על אחריותך בלבד.

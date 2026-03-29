# 🔭 Sentimental Scout

> AI-powered crypto sentiment analysis — Telegram Mini-App

A production-ready MVP with a dark trading-terminal UI, FastAPI backend, Supabase persistence, and Telegram Stars payments.

---

## Project Structure

```
sentimental-scout/
├── frontend/               ← Next.js 14 (App Router) + Tailwind
│   ├── app/
│   │   ├── page.tsx        ← Main Mini-App UI
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── package.json
│   ├── tailwind.config.ts
│   ├── next.config.js
│   └── .env.example
├── backend/
│   ├── bot.py              ← FastAPI server (webhook + API)
│   ├── requirements.txt
│   ├── register_webhook.py ← One-time webhook registration
│   └── .env.example
├── schema.sql              ← Supabase/PostgreSQL schema
├── render.yaml             ← Render.com IaC
└── README.md
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| Python | ≥ 3.11 |
| Telegram Bot | Created via [@BotFather](https://t.me/BotFather) |
| Supabase project | Free tier works |

---

## Step 1 — Database (Supabase)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run `schema.sql` in full.
3. Copy your **Project URL** and **service_role** key from *Settings → API*.

Optional: Set up a **pg_cron** job to reset daily scans:
```sql
SELECT cron.schedule('reset-daily-scans', '0 0 * * *', 'SELECT reset_daily_scans()');
```

---

## Step 2 — Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts.
2. Save the **BOT_TOKEN**.
3. Enable payments: `/mybots` → your bot → **Payments** → choose a provider  
   (for Telegram Stars, use **"Telegram Stars"** — no external provider needed).
4. Set the Mini-App URL after deploying the frontend:  
   `/mybots` → your bot → **Menu Button** → set URL.

---

## Step 3 — Backend (Render.com)

### Local dev

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Fill in BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, MINI_APP_URL

uvicorn bot:app --reload --port 8000
```

### Deploy to Render

1. Push the repo to GitHub.
2. In Render dashboard → **New → Web Service** → connect repo.
3. Set **Root Directory** to `backend`.
4. Add all env vars from `.env.example` in the Render dashboard.
5. Render will use `render.yaml` for the build/start commands automatically.

### Register the webhook (run once after deploy)

```bash
export BOT_TOKEN=...
export BACKEND_URL=https://sentimental-scout-api.onrender.com
export WEBHOOK_SECRET=...     # same value as in Render env vars

python backend/register_webhook.py
```

---

## Step 4 — Frontend (Vercel)

### Local dev

```bash
cd frontend
npm install

cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:8000

npm run dev
```

### Deploy to Vercel

```bash
npm i -g vercel
cd frontend
vercel --prod
```

Add the environment variable in the Vercel dashboard:
```
NEXT_PUBLIC_API_URL = https://sentimental-scout-api.onrender.com
```

After deploying, copy the Vercel URL and:
- Update `MINI_APP_URL` in Render env vars.
- Set the bot's menu button URL in BotFather.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/sentiment` | Analyze ticker sentiment |
| `GET` | `/api/user/{tg_id}` | User profile + history |
| `POST` | `/api/pay/invoice` | Create Stars invoice |
| `POST` | `/api/pay/confirm` | Confirm payment + upgrade |
| `POST` | `/webhook` | Telegram Bot webhook |

---

## Plugging in Real Sentiment Logic

In `backend/bot.py`, replace the `mock_sentiment_analysis()` function:

```python
def mock_sentiment_analysis(ticker: str) -> dict:
    # ← swap this with your Helius / LLM / social API calls
    ...
```

Suggested integrations:
- **Helius** — on-chain activity, whale wallets, holder changes
- **OpenAI / Claude** — summarise social mentions into a score
- **Santiment / LunarCrush** — social volume & sentiment feeds
- **CoinGecko** — price momentum data

The return shape must match:
```python
{
    "ticker": str,
    "score": float,        # –100 to +100
    "label": str,          # "Bullish" | "Bearish" | "Neutral"
    "color": str,          # hex colour
    "emoji": str,
    "signals": dict,       # arbitrary sub-signals
    "generated_at": int,   # unix timestamp
}
```

---

## Subscription Tiers

| Feature | Free | Pro ⭐ |
|---------|------|--------|
| Scans per day | 3 | Unlimited |
| Scan history | Last 20 | Last 20 |
| Price | — | 100 Telegram Stars |

Stars price is configurable via `PRO_STARS_PRICE` env var.

---

## Security Notes

- The backend uses the `X-Telegram-Bot-Api-Secret-Token` header to verify webhook authenticity.
- Supabase Row-Level Security is enabled; the service-role key bypasses it server-side only.
- Never expose `SUPABASE_SERVICE_KEY` to the frontend.

---

## License

MIT

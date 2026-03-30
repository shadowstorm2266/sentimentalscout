"""
Sentimental Scout — FastAPI Backend
────────────────────────────────────
Endpoints
  POST /webhook          — Telegram Bot webhook receiver
  POST /api/sentiment    — Sentiment analysis (mock, swap in your LLM/Helius)
  POST /api/pay/invoice  — Create Telegram Stars invoice
  POST /api/pay/confirm  — Confirm Stars payment & upgrade user
  GET  /api/user/{tg_id} — Fetch user profile + scan history
  GET  /health           — Health check
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import random
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("scout")

# ── Env vars ─────────────────────────────────────────────────────────────────
BOT_TOKEN: str       = os.environ["BOT_TOKEN"]
SUPABASE_URL: str    = os.environ["SUPABASE_URL"]
SUPABASE_KEY: str    = os.environ["SUPABASE_SERVICE_KEY"]   # service-role key
WEBHOOK_SECRET: str  = os.environ.get("WEBHOOK_SECRET", "")
PRO_STARS_PRICE: int = int(os.environ.get("PRO_STARS_PRICE", "100"))

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

FREE_SCANS_PER_DAY = 3

# ── Supabase client ───────────────────────────────────────────────────────────
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Sentimental Scout API starting…")
    yield
    log.info("Sentimental Scout API shutting down.")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Sentimental Scout API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic models ───────────────────────────────────────────────────────────
class SentimentRequest(BaseModel):
    ticker: str
    telegram_id: int


class PayInvoiceRequest(BaseModel):
    telegram_id: int
    chat_id: int


class PayConfirmRequest(BaseModel):
    telegram_charge_id: str
    telegram_id: int
    stars_amount: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def verify_telegram_signature(body: bytes, secret: str, header_hash: str) -> bool:
    """Verify X-Telegram-Bot-Api-Secret-Token header."""
    if not secret or not header_hash:
        return True  # skip if either side is missing
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_hash)


async def tg_post(method: str, payload: dict[str, Any]) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{TG_API}/{method}", json=payload, timeout=10)
        r.raise_for_status()
        return r.json()


def upsert_user(tg_user: dict) -> dict:
    """Create or fetch a user row; returns the row."""
    data = {
        "telegram_id": tg_user["id"],
        "telegram_username": tg_user.get("username"),
        "first_name": tg_user.get("first_name"),
        "last_name": tg_user.get("last_name"),
    }
    res = (
        supabase.table("users")
        .upsert(data, on_conflict="telegram_id")
        .execute()
    )
    if res.data and len(res.data) > 0:
        return res.data[0]
    # fallback: fetch the user
    return get_user(tg_user["id"]) or data


def get_user(telegram_id: int) -> dict | None:
    res = (
        supabase.table("users")
        .select("*")
        .eq("telegram_id", telegram_id)
        .limit(1)
        .execute()
    )
    if res.data and len(res.data) > 0:
        return res.data[0]
    return None


def can_scan(user: dict) -> bool:
    if user["subscription"] == "pro":
        return True
    return user["scans_today"] < FREE_SCANS_PER_DAY


def increment_scan_count(user_id: str) -> None:
    supabase.rpc(
        "increment_scans",
        {"uid": user_id},
    ).execute()
    # Fallback raw update if RPC not defined:
    supabase.table("users").update(
        {"scans_today": supabase.table("users")
         .select("scans_today")
         .eq("id", user_id)
         .single()
         .execute()
         .data["scans_today"] + 1}
    ).eq("id", user_id).execute()


def save_scan(user_id: str, ticker: str, result: dict) -> dict:
    row = {
        "user_id": user_id,
        "ticker": ticker.upper(),
        "sentiment_score": result["score"],
        "sentiment_label": result["label"],
        "raw_payload": result,
    }
    res = supabase.table("scans").insert(row).execute()
    return res.data[0]


# ── Mock sentiment engine ─────────────────────────────────────────────────────
# ⬇  Replace this entire function with your Helius / LLM integration.

def mock_sentiment_analysis(ticker: str) -> dict:
    """
    Returns a deterministic-ish mock sentiment result.
    Swap with real NLP / on-chain data later.
    """
    random.seed(ticker.upper() + str(int(time.time() // 3600)))  # hourly variation
    score: float = round(random.uniform(-85, 95), 2)

    if score >= 30:
        label = "Bullish"
        color = "#00ff9d"
        emoji = "🚀"
    elif score <= -30:
        label = "Bearish"
        color = "#ff3366"
        emoji = "🔻"
    else:
        label = "Neutral"
        color = "#f5c518"
        emoji = "⚖️"

    signals = {
        "social_volume": random.randint(200, 50_000),
        "whale_activity": random.choice(["Low", "Moderate", "High"]),
        "dev_activity": random.randint(0, 100),
        "fear_greed_index": random.randint(0, 100),
        "price_momentum": round(random.uniform(-15, 15), 2),
    }

    return {
        "ticker": ticker.upper(),
        "score": score,
        "label": label,
        "color": color,
        "emoji": emoji,
        "signals": signals,
        "generated_at": int(time.time()),
        "source": "mock",
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "sentimental-scout"}


@app.post("/api/sentiment")
async def get_sentiment(req: SentimentRequest):
    ticker = req.ticker.strip().upper()
    if not ticker or len(ticker) > 10:
        raise HTTPException(400, "Invalid ticker")

    user = get_user(req.telegram_id)
    if not user:
        raise HTTPException(404, "User not found. Open the bot first.")

    if not can_scan(user):
        raise HTTPException(
            429,
            f"Free tier limit reached ({FREE_SCANS_PER_DAY} scans/day). Upgrade to Pro ⭐",
        )

    result = mock_sentiment_analysis(ticker)

    try:
        save_scan(user["id"], ticker, result)
        # naive increment (avoids extra RPC)
        supabase.table("users").update(
            {"scans_today": user["scans_today"] + 1}
        ).eq("id", user["id"]).execute()
    except Exception as exc:
        log.warning("DB write failed: %s", exc)

    return result


@app.post("/api/pay/invoice")
async def create_invoice(req: PayInvoiceRequest):
    """Send a Telegram Stars invoice to the user's chat."""
    payload = {
        "chat_id": req.chat_id,
        "title": "Sentimental Scout Pro",
        "description": "Unlimited scans · Priority signals · Whale alerts",
        "payload": json.dumps({"telegram_id": req.telegram_id, "plan": "pro"}),
        "currency": "XTR",          # Telegram Stars
        "prices": [{"label": "Pro Subscription (30 days)", "amount": PRO_STARS_PRICE}],
    }
    res = await tg_post("sendInvoice", payload)
    if not res.get("ok"):
        raise HTTPException(500, f"Telegram error: {res}")
    return {"ok": True, "message_id": res["result"]["message_id"]}


@app.post("/api/pay/confirm")
async def confirm_payment(req: PayConfirmRequest):
    """Called after successful_payment is received in the webhook."""
    user = get_user(req.telegram_id)
    if not user:
        raise HTTPException(404, "User not found")

    # Record payment
    supabase.table("star_payments").insert({
        "user_id": user["id"],
        "telegram_charge_id": req.telegram_charge_id,
        "stars_amount": req.stars_amount,
        "plan": "pro",
        "status": "completed",
    }).execute()

    # Upgrade user
    supabase.table("users").update({"subscription": "pro"}).eq(
        "id", user["id"]
    ).execute()

    return {"ok": True, "subscription": "pro"}


@app.get("/api/user/{telegram_id}")
async def get_user_profile(telegram_id: int):
    user = get_user(telegram_id)
    if not user:
        raise HTTPException(404, "User not found")

    scans = (
        supabase.table("scans")
        .select("*")
        .eq("user_id", user["id"])
        .order("created_at", desc=True)
        .limit(20)
        .execute()
        .data
    )

    return {
        "user": user,
        "recent_scans": scans,
        "scans_remaining": (
            "∞" if user["subscription"] == "pro"
            else max(0, FREE_SCANS_PER_DAY - user["scans_today"])
        ),
    }


# ── Telegram Webhook ──────────────────────────────────────────────────────────

@app.post("/webhook")
async def webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    body = await request.body()

    if WEBHOOK_SECRET and not verify_telegram_signature(
        body, WEBHOOK_SECRET, x_telegram_bot_api_secret_token or ""
    ):
        raise HTTPException(403, "Bad signature")

    update: dict = await request.json()
    background_tasks.add_task(handle_update, update)
    return {"ok": True}


async def handle_update(update: dict) -> None:
    try:
        # ── Successful payment ────────────────────────────────────────────
        if msg := update.get("message"):
            tg_user = msg["from"]
            upsert_user(tg_user)

            if payment := msg.get("successful_payment"):
                charge_id = payment["telegram_payment_charge_id"]
                stars = payment["total_amount"]
                inner = json.loads(payment["invoice_payload"])

                await confirm_payment(
                    PayConfirmRequest(
                        telegram_charge_id=charge_id,
                        telegram_id=tg_user["id"],
                        stars_amount=stars,
                    )
                )

                await tg_post(
                    "sendMessage",
                    {
                        "chat_id": msg["chat"]["id"],
                        "text": (
                            "⭐ *Payment confirmed!* You're now a Pro member.\n"
                            "Open Sentimental Scout and enjoy unlimited scans 🚀"
                        ),
                        "parse_mode": "Markdown",
                    },
                )
                return

            # ── /start command ────────────────────────────────────────────
            text: str = msg.get("text", "")
            if text.startswith("/start"):
                await tg_post(
                    "sendMessage",
                    {
                        "chat_id": msg["chat"]["id"],
                        "text": (
                            "👋 Welcome to *Sentimental Scout*!\n\n"
                            "Open the app to scan crypto tickers and get AI-powered "
                            "sentiment analysis.\n\n"
                            "Free plan: 3 scans/day · Pro plan: unlimited ⭐"
                        ),
                        "parse_mode": "Markdown",
                        "reply_markup": {
                            "inline_keyboard": [[
                                {
                                    "text": "🚀 Open Scout",
                                    "web_app": {"url": os.environ.get("MINI_APP_URL", "https://example.com")},
                                }
                            ]]
                        },
                    },
                )

        # ── Pre-checkout query (must be answered within 10 s) ─────────────
        elif pcq := update.get("pre_checkout_query"):
            await tg_post(
                "answerPreCheckoutQuery",
                {"pre_checkout_query_id": pcq["id"], "ok": True},
            )

    except Exception as exc:
        log.exception("handle_update failed: %s", exc)

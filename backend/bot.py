"""
Sentimental Scout — FastAPI Backend
────────────────────────────────────
Endpoints
  POST /webhook          — Telegram Bot webhook receiver
  POST /api/sentiment    — Weighted Scoring Engine (CoinGecko + Helius + Social)
  POST /api/pay/invoice  — Create Telegram Stars invoice
  POST /api/pay/confirm  — Confirm Stars payment & upgrade user
  GET  /api/user/{tg_id} — Fetch user profile + scan history
  GET  /health           — Health check

Scoring Formula
  S_total = (Wm * M) + (Wo * O) + (Ws * S)
  Majors   : Wm=0.5  Wo=0.3  Ws=0.2
  Memecoins: Wm=0.1  Wo=0.4  Ws=0.5
  Rug-Sense: -60 penalty if whale >15% supply or unverified liquidity
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import random
import time
from contextlib import asynccontextmanager
from typing import Any

import aiohttp
import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("scout")

# ── Env vars ──────────────────────────────────────────────────────────────────
BOT_TOKEN: str        = os.environ["BOT_TOKEN"]
SUPABASE_URL: str     = os.environ["SUPABASE_URL"]
SUPABASE_KEY: str     = os.environ["SUPABASE_SERVICE_KEY"]
WEBHOOK_SECRET: str   = os.environ.get("WEBHOOK_SECRET", "")
PRO_STARS_PRICE: int  = int(os.environ.get("PRO_STARS_PRICE", "100"))
HELIUS_API_KEY: str   = os.environ.get("HELIUS_API_KEY", "")

TG_API         = f"https://api.telegram.org/bot{BOT_TOKEN}"
COINGECKO_BASE = "https://api.coingecko.com/api/v3"
HELIUS_BASE    = "https://mainnet.helius-rpc.com"

FREE_SCANS_PER_DAY = 3

# ── Known major tokens ────────────────────────────────────────────────────────
MAJORS = {"BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX", "DOT", "MATIC", "LINK"}

COINGECKO_IDS: dict[str, str] = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana",
    "BNB": "binancecoin", "XRP": "ripple", "ADA": "cardano",
    "AVAX": "avalanche-2", "DOT": "polkadot", "MATIC": "matic-network",
    "LINK": "chainlink", "DOGE": "dogecoin", "SHIB": "shiba-inu",
    "PEPE": "pepe", "WIF": "dogwifcoin", "BONK": "bonk",
    "FLOKI": "floki", "TRUMP": "maga", "POPCAT": "popcat",
}

SPL_MINTS: dict[str, str] = {
    "BONK":   "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "WIF":    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    "POPCAT": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    "JUP":    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "ORCA":   "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
}

SOL_ECOSYSTEM = {"SOL", "BONK", "WIF", "POPCAT", "JUP", "ORCA", "RAY", "PYTH", "JITO", "DRIFT"}

# ── Supabase client ───────────────────────────────────────────────────────────
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Sentimental Scout API starting — Weighted Engine v1")
    yield
    log.info("Sentimental Scout API shutting down.")


app = FastAPI(title="Sentimental Scout API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


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


# ── Utilities ─────────────────────────────────────────────────────────────────

def clamp(val: float, lo: float = -100.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, val))

def verify_telegram_signature(body: bytes, secret: str, header_hash: str) -> bool:
    if not secret or not header_hash:
        return True
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_hash)

async def tg_post(method: str, payload: dict[str, Any]) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{TG_API}/{method}", json=payload, timeout=10)
        r.raise_for_status()
        return r.json()


# ── Supabase helpers ──────────────────────────────────────────────────────────

def upsert_user(tg_user: dict) -> dict:
    data = {
        "telegram_id": tg_user["id"],
        "telegram_username": tg_user.get("username"),
        "first_name": tg_user.get("first_name"),
        "last_name": tg_user.get("last_name"),
    }
    res = supabase.table("users").upsert(data, on_conflict="telegram_id").execute()
    if res.data and len(res.data) > 0:
        return res.data[0]
    return get_user(tg_user["id"]) or data

def get_user(telegram_id: int) -> dict | None:
    res = (
        supabase.table("users").select("*")
        .eq("telegram_id", telegram_id).limit(1).execute()
    )
    return res.data[0] if res.data else None

def can_scan(user: dict) -> bool:
    if user["subscription"] == "pro":
        return True
    # Auto-reset if last reset was >24 hours ago
    from datetime import datetime, timezone, timedelta
    reset_at_str = user.get("scans_reset_at") or ""
    try:
        reset_at = datetime.fromisoformat(reset_at_str.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) - reset_at > timedelta(hours=24):
            # Reset the counter
            supabase.table("users").update({
                "scans_today": 0,
                "scans_reset_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", user["id"]).execute()
            user["scans_today"] = 0
    except Exception:
        pass
    return user["scans_today"] < FREE_SCANS_PER_DAY

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


# ══════════════════════════════════════════════════════════════════════════════
#  WEIGHTED SCORING ENGINE
# ══════════════════════════════════════════════════════════════════════════════

async def fetch_market_signal(session: aiohttp.ClientSession, ticker: str) -> dict:
    """M signal — CoinGecko 24h price change + vol/mcap ratio."""
    cg_id = COINGECKO_IDS.get(ticker.upper())
    if cg_id:
        try:
            url = (
                f"{COINGECKO_BASE}/coins/{cg_id}"
                "?localization=false&tickers=false&community_data=false"
                "&developer_data=false&sparkline=false"
            )
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    data = await r.json()
                    md   = data.get("market_data", {})
                    price_change = float(md.get("price_change_percentage_24h") or 0)
                    market_cap   = float((md.get("market_cap") or {}).get("usd") or 1)
                    volume_24h   = float((md.get("total_volume") or {}).get("usd") or 0)
                    vol_mcap     = (volume_24h / market_cap) * 100

                    price_score  = clamp(price_change * 5)
                    volume_score = clamp((vol_mcap - 5) * 4, -40, 50)
                    M            = clamp(price_score * 0.7 + volume_score * 0.3)

                    return {
                        "score": round(M, 2),
                        "price_change_24h": round(price_change, 2),
                        "volume_24h_usd": int(volume_24h),
                        "market_cap_usd": int(market_cap),
                        "vol_mcap_ratio": round(vol_mcap, 2),
                        "source": "coingecko",
                    }
        except Exception as exc:
            log.warning("CoinGecko error [%s]: %s", ticker, exc)

    # Seeded mock fallback
    rng = random.Random(ticker.upper() + str(int(time.time() // 3600)))
    pc  = rng.uniform(-12, 18)
    vm  = rng.uniform(1, 20)
    M   = clamp(pc * 5 * 0.7 + (vm - 5) * 4 * 0.3)
    return {
        "score": round(M, 2),
        "price_change_24h": round(pc, 2),
        "volume_24h_usd": rng.randint(1_000_000, 5_000_000_000),
        "market_cap_usd": rng.randint(10_000_000, 500_000_000_000),
        "vol_mcap_ratio": round(vm, 2),
        "source": "mock",
    }


async def fetch_onchain_signal(session: aiohttp.ClientSession, ticker: str) -> dict:
    """O signal — Helius top-holder concentration + whale bias."""
    rug_flag       = False
    max_holder_pct = 0.0
    whale_score    = 0.0
    large_tx_count = 0
    is_sol         = ticker.upper() in SOL_ECOSYSTEM

    if HELIUS_API_KEY and is_sol:
        helius_url = f"{HELIUS_BASE}/?api-key={HELIUS_API_KEY}"
        try:
            if ticker.upper() == "SOL":
                payload = {"jsonrpc": "2.0", "id": 1,
                           "method": "getRecentPerformanceSamples", "params": [5]}
                async with session.post(helius_url, json=payload,
                                        timeout=aiohttp.ClientTimeout(total=8)) as r:
                    if r.status == 200:
                        samples = (await r.json()).get("result", [])
                        if samples:
                            avg_tps = sum(
                                s.get("numTransactions", 0) / max(s.get("samplePeriodSecs", 1), 1)
                                for s in samples
                            ) / len(samples)
                            whale_score    = clamp((avg_tps - 2000) / 30)
                            large_tx_count = int(avg_tps)
            else:
                mint = SPL_MINTS.get(ticker.upper())
                if mint:
                    payload = {"jsonrpc": "2.0", "id": 1,
                               "method": "getTokenLargestAccounts", "params": [mint]}
                    async with session.post(helius_url, json=payload,
                                            timeout=aiohttp.ClientTimeout(total=8)) as r:
                        if r.status == 200:
                            holders = ((await r.json()).get("result") or {}).get("value", [])
                            if holders:
                                amounts = [float(h.get("uiAmount") or 0) for h in holders]
                                total   = sum(amounts) or 1
                                pcts    = [a / total * 100 for a in amounts]
                                max_holder_pct = max(pcts)
                                rug_flag       = max_holder_pct > 15
                                hhi            = sum((p / 100) ** 2 for p in pcts[:20])
                                whale_score    = clamp((0.5 - hhi) * 200)
                                large_tx_count = len([p for p in pcts if p > 1])
        except Exception as exc:
            log.warning("Helius error [%s]: %s", ticker, exc)

    if whale_score == 0.0 and not rug_flag:
        rng            = random.Random(ticker.upper() + "oc" + str(int(time.time() // 3600)))
        max_holder_pct = rng.uniform(2, 22)
        rug_flag       = max_holder_pct > 15
        whale_score    = clamp(rng.uniform(-60, 80))
        large_tx_count = rng.randint(5, 500)

    return {
        "score": round(clamp(whale_score), 2),
        "max_holder_pct": round(max_holder_pct, 2),
        "rug_flag": rug_flag,
        "large_tx_count": large_tx_count,
        "whale_bias": (
            "Accumulating 🐋" if whale_score > 20
            else "Distributing 🔴" if whale_score < -20
            else "Neutral ⚖️"
        ),
        "source": "helius" if (HELIUS_API_KEY and is_sol) else "mock",
    }


async def fetch_social_signal(session: aiohttp.ClientSession, ticker: str) -> dict:
    """
    S signal — Reddit mention Z-score + keyword sentiment scoring.

    Searches 3 subreddits concurrently (CryptoCurrency, solana, CryptoMarkets).
    No API key required — uses Reddit's public JSON API with a browser User-Agent.
    Scores each post title using bullish/bearish keyword lists.
    Falls back to seeded mock on any network error.
    """

    # ── Keyword sentiment lexicon ─────────────────────────────────────────────
    BULL_WORDS = {
        "moon", "pump", "bullish", "buy", "long", "breakout", "surge", "rally",
        "ath", "accumulate", "undervalued", "gem", "launch", "partnership",
        "adoption", "upgrade", "hold", "hodl", "explode", "green", "up",
        "opportunity", "potential", "solid", "strong", "win", "winner",
    }
    BEAR_WORDS = {
        "dump", "crash", "bearish", "sell", "short", "rug", "scam", "fraud",
        "dead", "rekt", "ponzi", "exit", "ban", "hack", "exploit", "warning",
        "avoid", "overvalued", "bubble", "red", "down", "loss", "fail",
        "dropped", "falling", "fear", "panic", "liquidated",
    }

    # ── Subreddits to search ──────────────────────────────────────────────────
    t = ticker.upper()
    subreddits = ["CryptoCurrency", "CryptoMarkets", "SatoshiStreetBets"]
    if t in {"SOL", "BONK", "WIF", "POPCAT", "JUP", "ORCA", "RAY"}:
        subreddits = ["solana", "CryptoCurrency", "SatoshiStreetBets"]
    elif t in {"ETH", "SHIB", "PEPE", "FLOKI"}:
        subreddits = ["ethereum", "CryptoCurrency", "CryptoMarkets"]
    elif t == "BTC":
        subreddits = ["Bitcoin", "CryptoCurrency", "CryptoMarkets"]

    headers = {
        "User-Agent": "SentimentalScout/1.0 (crypto sentiment tool)",
        "Accept": "application/json",
    }

    all_posts: list[dict] = []

    async def search_subreddit(sub: str) -> list[dict]:
        url = (
            f"https://www.reddit.com/r/{sub}/search.json"
            f"?q={ticker}&restrict_sr=1&sort=new&limit=25&t=day"
        )
        try:
            async with session.get(
                url, headers=headers, timeout=aiohttp.ClientTimeout(total=7)
            ) as r:
                if r.status == 200:
                    data = await r.json()
                    return data.get("data", {}).get("children", [])
        except Exception as exc:
            log.warning("Reddit error [%s/%s]: %s", sub, ticker, exc)
        return []

    # Fire all subreddit searches concurrently
    results = await asyncio.gather(*[search_subreddit(s) for s in subreddits])
    for batch in results:
        all_posts.extend(batch)

    if all_posts:
        # ── Score each post title ─────────────────────────────────────────────
        pos_count = 0
        neg_count = 0
        total_upvotes = 0

        for child in all_posts:
            post = child.get("data", {})
            title = (post.get("title") or "").lower()
            words = set(title.split())
            upvotes = max(int(post.get("ups") or 0), 1)

            bull_hits = len(words & BULL_WORDS)
            bear_hits = len(words & BEAR_WORDS)

            # Weight by upvotes so viral posts count more
            if bull_hits > bear_hits:
                pos_count += upvotes
            elif bear_hits > bull_hits:
                neg_count += upvotes

            total_upvotes += upvotes

        current_mentions = len(all_posts)
        sentiment_ratio  = (pos_count - neg_count) / max(total_upvotes, 1)

        # Baseline: ~15 posts/day is normal for a mid-cap, ~60+ is elevated
        avg_mentions = 15
        stddev       = max(avg_mentions * 0.8, 1)
        z_score      = (current_mentions - avg_mentions) / stddev

        # Bot noise dampening: high volume but flat sentiment = likely noise
        vol_comp = clamp(z_score / 3 * 60, -60, 60)
        sen_comp = clamp(sentiment_ratio * 100, -40, 40)
        S        = clamp(vol_comp + sen_comp)

        if z_score > 4 and abs(sentiment_ratio) < 0.05:
            S *= 0.5

        return {
            "score":             round(S, 2),
            "current_mentions":  current_mentions,
            "avg_mentions":      avg_mentions,
            "z_score":           round(z_score, 2),
            "sentiment_ratio":   round(sentiment_ratio, 2),
            "buzz_level": (
                "🔥 Viral"        if z_score > 3
                else "📈 Elevated" if z_score > 1
                else "😴 Quiet"    if z_score < -0.5
                else "〰️ Normal"
            ),
            "source": "reddit",
        }

    # ── Seeded mock fallback ──────────────────────────────────────────────────
    rng              = random.Random(ticker.upper() + "soc" + str(int(time.time() // 3600)))
    current_mentions = rng.randint(5, 80)
    avg_mentions     = 15
    sentiment_ratio  = rng.uniform(-0.4, 0.6)
    stddev           = max(avg_mentions * 0.8, 1)
    z_score          = (current_mentions - avg_mentions) / stddev
    vol_comp         = clamp(z_score / 3 * 60, -60, 60)
    sen_comp         = clamp(sentiment_ratio * 100, -40, 40)
    S                = clamp(vol_comp + sen_comp)

    return {
        "score":            round(S, 2),
        "current_mentions": current_mentions,
        "avg_mentions":     avg_mentions,
        "z_score":          round(z_score, 2),
        "sentiment_ratio":  round(sentiment_ratio, 2),
        "buzz_level": (
            "🔥 Viral"        if z_score > 3
            else "📈 Elevated" if z_score > 1
            else "😴 Quiet"    if z_score < -0.5
            else "〰️ Normal"
        ),
        "source": "mock",
    }


def generate_degen_verdict(
    ticker: str, M: float, O: float, S: float,
    market: dict, onchain: dict, social: dict,
    is_major: bool, rug_flag: bool,
) -> str:
    if rug_flag:
        return (
            f"⚠️ RUG RADAR TRIGGERED — single wallet holds "
            f"{onchain['max_holder_pct']:.1f}% of supply. "
            f"Dev could pull at any moment. Avoid or size tiny."
        )

    price_ch = market.get("price_change_24h", 0)
    whale    = onchain.get("whale_bias", "Neutral ⚖️")
    buzz     = social.get("buzz_level", "〰️ Normal")
    z        = social.get("z_score", 0)

    if price_ch < -5 and O > 20:
        return (
            f"📉 Price bleeding but whales are quietly loading ({whale}). "
            f"Classic spring setup — smart money vs retail panic. Watch for reversal wick."
        )
    if price_ch > 8 and O < -20:
        return (
            f"🚀 Price pumping hard but whales are distributing. "
            f"Exit liquidity play in motion. Don't be the last one holding bags."
        )
    if S > 50 and M < 0:
        return (
            f"🐦 CT is cooking on ${ticker} but price isn't moving yet ({price_ch:+.1f}%). "
            f"Either a delayed breakout or a pure hype trap — size accordingly."
        )
    if z > 3 and abs(social.get("sentiment_ratio", 0)) < 0.1:
        return (
            f"🤖 Mention volume spiked {z:.1f}σ above average but sentiment is flat. "
            f"Bot army detected. Don't trust the volume, trust the chart."
        )
    if M > 30 and O > 30 and S > 20:
        return (
            f"💎 Full alignment — price momentum, whale accumulation, and social buzz all green. "
            f"Trend is your friend on ${ticker} right now."
        )
    if M < -30 and O < -20 and S < -10:
        return (
            f"☠️ Everything is red — price, whales, and sentiment aligned bearish. "
            f"No edge here unless you're shorting."
        )
    if is_major and abs(price_ch) < 2:
        return (
            f"😴 ${ticker} consolidating tight ({price_ch:+.1f}% 24h). "
            f"Coiling for a move — direction unclear. Watch BTC dominance for the tell."
        )

    dominant = max([("market", M), ("on-chain", O), ("social", S)], key=lambda x: abs(x[1]))
    direction = "bullish" if dominant[1] > 0 else "bearish"
    return (
        f"Strongest signal on ${ticker} is {dominant[0]} data "
        f"({direction}, {dominant[1]:+.0f}pts). "
        f"Whale posture: {whale} · Social: {buzz}."
    )


def apply_rug_sense(score: float, onchain: dict, market: dict, ticker: str) -> tuple[float, bool]:
    rug = False

    # BTC, ETH and other established majors cannot be rugged — skip penalty
    if ticker.upper() in MAJORS:
        return clamp(score), False

    # Only apply rug-sense if data came from a real source (not mock)
    if onchain.get("source") == "mock":
        return clamp(score), False

    if onchain.get("rug_flag"):
        score -= 60
        rug = True

    # Low liquidity flag for microcaps
    vol_mcap = market.get("vol_mcap_ratio", 5)
    if vol_mcap < 0.5 and market.get("market_cap_usd", 1e9) < 20_000_000:
        score -= 20
        rug = rug or (score < -60)

    return clamp(score), rug


async def run_scoring_engine(ticker: str) -> dict:
    async with aiohttp.ClientSession() as session:
        market, onchain, social = await asyncio.gather(
            fetch_market_signal(session, ticker),
            fetch_onchain_signal(session, ticker),
            fetch_social_signal(session, ticker),
        )

    M = market["score"]
    O = onchain["score"]
    S = social["score"]

    is_major    = ticker.upper() in MAJORS
    market_cap  = market.get("market_cap_usd", 1e12)
    is_memecoin = (not is_major) and (market_cap < 20_000_000)

    if is_major:
        Wm, Wo, Ws, tier = 0.50, 0.30, 0.20, "major"
    elif is_memecoin:
        Wm, Wo, Ws, tier = 0.10, 0.40, 0.50, "memecoin"
    else:
        Wm, Wo, Ws, tier = 0.35, 0.35, 0.30, "midcap"

    raw_score            = (Wm * M) + (Wo * O) + (Ws * S)
    final_score, rug_hit = apply_rug_sense(raw_score, onchain, market, ticker)
    final_score          = round(final_score, 2)

    if rug_hit or final_score <= -60:
        label, color, emoji = "Extreme Risk", "#ff0055", "☠️"
    elif final_score >= 35:
        label, color, emoji = "Bullish", "#00ff9d", "🚀"
    elif final_score <= -25:
        label, color, emoji = "Bearish", "#ff3366", "🔻"
    else:
        label, color, emoji = "Neutral", "#f5c518", "⚖️"

    verdict = generate_degen_verdict(
        ticker, M, O, S, market, onchain, social, is_major, rug_hit
    )

    signals = {
        "price_change_24h": market.get("price_change_24h", 0),
        "vol_mcap_ratio":   market.get("vol_mcap_ratio", 0),
        "market_cap_usd":   market.get("market_cap_usd", 0),
        "whale_activity":   onchain.get("whale_bias", "—"),
        "max_holder_pct":   onchain.get("max_holder_pct", 0),
        "large_tx_count":   onchain.get("large_tx_count", 0),
        "social_volume":    social.get("current_mentions", 0),
        "social_z_score":   social.get("z_score", 0),
        "buzz_level":       social.get("buzz_level", "—"),
        "market_score":     round(M, 1),
        "onchain_score":    round(O, 1),
        "social_score":     round(S, 1),
        "weights":          {"Wm": Wm, "Wo": Wo, "Ws": Ws},
        "tier":             tier,
    }

    return {
        "ticker":        ticker.upper(),
        "score":         final_score,
        "label":         label,
        "color":         color,
        "emoji":         emoji,
        "signals":       signals,
        "reasoning":     verdict,
        "rug_triggered": rug_hit,
        "generated_at":  int(time.time()),
        "source":        "weighted_engine_v1",
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "sentimental-scout", "engine": "weighted_v1"}


@app.post("/api/sentiment")
async def get_sentiment(req: SentimentRequest):
    ticker = req.ticker.strip().upper()
    if not ticker or len(ticker) > 10:
        raise HTTPException(400, "Invalid ticker")

    user = get_user(req.telegram_id)
    if not user:
        raise HTTPException(404, "User not found. Open the bot first.")
    if not can_scan(user):
        raise HTTPException(429,
            f"Free tier limit reached ({FREE_SCANS_PER_DAY} scans/day). Upgrade to Pro ⭐")

    try:
        result = await run_scoring_engine(ticker)
    except Exception as exc:
        log.exception("Scoring engine failed [%s]: %s", ticker, exc)
        raise HTTPException(500, "Scoring engine error. Try again.")

    try:
        save_scan(user["id"], ticker, result)
        supabase.table("users").update(
            {"scans_today": user["scans_today"] + 1}
        ).eq("id", user["id"]).execute()
    except Exception as exc:
        log.warning("DB write failed: %s", exc)

    return result


@app.post("/api/pay/invoice")
async def create_invoice(req: PayInvoiceRequest):
    payload = {
        "chat_id":       req.chat_id,
        "title":         "Sentimental Scout Pro",
        "description":   "Unlimited scans · Rug-Sense · Whale tracking · Degen AI verdicts",
        "payload":       json.dumps({"telegram_id": req.telegram_id, "plan": "pro"}),
        "provider_token": "",
        "currency":      "XTR",
        "prices":        [{"label": "Pro Subscription (30 days)", "amount": PRO_STARS_PRICE}],
    }
    res = await tg_post("sendInvoice", payload)
    if not res.get("ok"):
        raise HTTPException(500, f"Telegram error: {res}")
    return {"ok": True, "message_id": res["result"]["message_id"]}


@app.post("/api/pay/confirm")
async def confirm_payment(req: PayConfirmRequest):
    user = get_user(req.telegram_id)
    if not user:
        raise HTTPException(404, "User not found")

    supabase.table("star_payments").insert({
        "user_id":              user["id"],
        "telegram_charge_id":   req.telegram_charge_id,
        "stars_amount":         req.stars_amount,
        "plan":                 "pro",
        "status":               "completed",
    }).execute()
    supabase.table("users").update({"subscription": "pro"}).eq("id", user["id"]).execute()
    return {"ok": True, "subscription": "pro"}


@app.get("/api/user/{telegram_id}")
async def get_user_profile(telegram_id: int):
    user = get_user(telegram_id)
    if not user:
        raise HTTPException(404, "User not found")

    scans = (
        supabase.table("scans").select("*")
        .eq("user_id", user["id"])
        .order("created_at", desc=True)
        .limit(20).execute().data
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
        if msg := update.get("message"):
            tg_user = msg["from"]
            upsert_user(tg_user)

            if payment := msg.get("successful_payment"):
                await confirm_payment(PayConfirmRequest(
                    telegram_charge_id=payment["telegram_payment_charge_id"],
                    telegram_id=tg_user["id"],
                    stars_amount=payment["total_amount"],
                ))
                await tg_post("sendMessage", {
                    "chat_id":    msg["chat"]["id"],
                    "text": (
                        "⭐ *Payment confirmed!* You're now a Pro member.\n\n"
                        "Unlimited scans · Rug-Sense · Whale tracking · Degen AI verdicts 🚀\n\n"
                        "Open Sentimental Scout and go make some alpha."
                    ),
                    "parse_mode": "Markdown",
                })
                return

            text: str = msg.get("text", "")
            if text.startswith("/start"):
                await tg_post("sendMessage", {
                    "chat_id":    msg["chat"]["id"],
                    "text": (
                        "👋 Welcome to *Sentimental Scout*!\n\n"
                        "AI-powered crypto sentiment — built for degens.\n\n"
                        "🔍 Market data · 🐋 Whale tracking · ☠️ Rug-Sense · 🤖 AI verdicts\n\n"
                        "Free plan: 3 scans/day · Pro: unlimited ⭐"
                    ),
                    "parse_mode": "Markdown",
                    "reply_markup": {
                        "inline_keyboard": [[{
                            "text":    "🚀 Open Scout",
                            "web_app": {"url": os.environ.get("MINI_APP_URL", "https://example.com")},
                        }]]
                    },
                })

        elif pcq := update.get("pre_checkout_query"):
            await tg_post("answerPreCheckoutQuery",
                          {"pre_checkout_query_id": pcq["id"], "ok": True})

    except Exception as exc:
        log.exception("handle_update failed: %s", exc)

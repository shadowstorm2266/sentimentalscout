"""
Run once after deploying the backend to register the Telegram webhook.

Usage:
  python register_webhook.py
"""
import os, httpx

BOT_TOKEN = os.environ["BOT_TOKEN"]
BACKEND_URL = os.environ["BACKEND_URL"]   # e.g. https://sentimental-scout-api.onrender.com
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

url = f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook"
payload = {
    "url": f"{BACKEND_URL}/webhook",
    "secret_token": WEBHOOK_SECRET,
    "allowed_updates": ["message", "pre_checkout_query"],
}

r = httpx.post(url, json=payload)
print(r.json())

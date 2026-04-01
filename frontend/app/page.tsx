"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface SentimentSignals {
  price_change_24h: number;
  vol_mcap_ratio: number;
  market_cap_usd: number;
  whale_activity: string;
  max_holder_pct: number;
  large_tx_count: number;
  social_volume: number;
  social_z_score: number;
  buzz_level: string;
  market_score: number;
  onchain_score: number;
  social_score: number;
  weights: { Wm: number; Wo: number; Ws: number };
  tier: string;
}

interface SentimentResult {
  ticker: string;
  score: number;
  label: "Bullish" | "Bearish" | "Neutral" | "Extreme Risk";
  color: string;
  emoji: string;
  signals: SentimentSignals;
  reasoning?: string;
  rug_triggered?: boolean;
  generated_at: number;
}

interface UserProfile {
  user: {
    telegram_id: number;
    first_name: string;
    subscription: "free" | "pro";
    scans_today: number;
  };
  scans_remaining: string | number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL ?? "https://your-api.onrender.com";

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function scoreToAngle(score: number) {
  // –100 → –90°  |  0 → 0°  |  +100 → +90°
  return (clamp(score, -100, 100) / 100) * 90;
}

function formatScore(score: number) {
  return score > 0 ? `+${score.toFixed(1)}` : score.toFixed(1);
}

// ── Needle SVG ────────────────────────────────────────────────────────────────
function Gauge({ score, color }: { score: number; color: string }) {
  const angle = scoreToAngle(score);

  return (
    <div className="relative w-full flex justify-center items-end" style={{ height: 140 }}>
      <svg viewBox="0 0 200 110" className="w-full max-w-[280px]" overflow="visible">
        {/* Track arcs */}
        {/* Bear zone */}
        <path
          d="M 20 100 A 80 80 0 0 1 100 20"
          fill="none" stroke="#ff336622" strokeWidth="18" strokeLinecap="round"
        />
        {/* Bull zone */}
        <path
          d="M 100 20 A 80 80 0 0 1 180 100"
          fill="none" stroke="#00ff9d22" strokeWidth="18" strokeLinecap="round"
        />
        {/* Active arc */}
        {score !== 0 && (
          <path
            d={
              score > 0
                ? "M 100 20 A 80 80 0 0 1 180 100"
                : "M 20 100 A 80 80 0 0 1 100 20"
            }
            fill="none"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="125"
            strokeDashoffset={125 - Math.abs(score / 100) * 125}
            opacity="0.7"
            style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)" }}
          />
        )}
        {/* Zone labels */}
        <text x="12" y="108" fill="#ff3366" fontSize="9" fontFamily="monospace" opacity="0.7">BEAR</text>
        <text x="157" y="108" fill="#00ff9d" fontSize="9" fontFamily="monospace" opacity="0.7">BULL</text>
        <text x="85" y="16" fill="#888" fontSize="8" fontFamily="monospace">NEUTRAL</text>

        {/* Tick marks */}
        {[-90, -60, -30, 0, 30, 60, 90].map((deg) => {
          const rad = ((deg - 90) * Math.PI) / 180;
          const x1 = 100 + 74 * Math.cos(rad);
          const y1 = 100 + 74 * Math.sin(rad);
          const x2 = 100 + 82 * Math.cos(rad);
          const y2 = 100 + 82 * Math.sin(rad);
          return (
            <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#444" strokeWidth={deg === 0 ? 2 : 1} />
          );
        })}

        {/* Needle */}
        <g
          style={{
            transform: `rotate(${angle}deg)`,
            transformOrigin: "100px 100px",
            transition: "transform 1.2s cubic-bezier(.34,1.56,.64,1)",
          }}
        >
          <line x1="100" y1="100" x2="100" y2="28"
            stroke={color} strokeWidth="2.5" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />
          <polygon points="96,100 104,100 100,90"
            fill={color} opacity="0.8" />
        </g>

        {/* Hub */}
        <circle cx="100" cy="100" r="6" fill="#0d0d14" stroke={color} strokeWidth="2"
          style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      </svg>

      {/* Score label */}
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 font-mono text-3xl font-bold tracking-tight"
        style={{ color, textShadow: `0 0 20px ${color}80`, transition: "color 0.5s" }}
      >
        {formatScore(score)}
      </div>
    </div>
  );
}

// ── Signal Row ────────────────────────────────────────────────────────────────
function SignalRow({ label, value, bar }: { label: string; value: string | number; bar?: number }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5">
      <span className="text-[11px] text-[#666] font-mono uppercase tracking-widest">{label}</span>
      <div className="flex items-center gap-2">
        {bar !== undefined && (
          <div className="w-16 h-[3px] bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${clamp(bar, 0, 100)}%`,
                background: bar > 60 ? "#00ff9d" : bar > 30 ? "#f5c518" : "#ff3366",
                transition: "width 0.8s ease",
              }}
            />
          </div>
        )}
        <span className="text-[12px] text-[#ccc] font-mono">{value}</span>
      </div>
    </div>
  );
}

// ── Scan History Row ──────────────────────────────────────────────────────────
function HistoryRow({ ticker, label, score }: { ticker: string; label: string; score: number }) {
  const color = label === "Bullish" ? "#00ff9d" : label === "Bearish" ? "#ff3366" : "#f5c518";
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded border border-white/5 bg-white/[0.02]">
      <span className="font-mono text-sm text-white font-bold">{ticker}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs" style={{ color }}>{label}</span>
        <span className="font-mono text-xs text-[#555]">{formatScore(score)}</span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [tgUser, setTgUser] = useState<{ id: number; first_name: string } | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [ticker, setTicker] = useState("");
  const [result, setResult] = useState<SentimentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"scan" | "history">("scan");
  const [scanHistory, setScanHistory] = useState<any[]>([]);
  const [payLoading, setPayLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Init Telegram WebApp ───────────────────────────────────────────────────
  useEffect(() => {
    const initTelegram = async () => {
      try {
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.ready();
        WebApp.expand();
        WebApp.setHeaderColor("#0d0d14");
        WebApp.setBackgroundColor("#0d0d14");

        const user = WebApp.initDataUnsafe?.user;
        if (user) setTgUser({ id: user.id, first_name: user.first_name ?? "Trader" });
      } catch {
        // Running outside Telegram (dev mode)
        setTgUser({ id: 999999999, first_name: "Dev" });
      }
    };
    initTelegram();
  }, []);

  // ── Fetch profile ──────────────────────────────────────────────────────────
  const fetchProfile = useCallback(async (id: number) => {
    try {
      const res = await fetch(`${API}/api/user/${id}`);
      if (res.ok) {
        const data: UserProfile = await res.json();
        setProfile(data);
        setScanHistory((data as any).recent_scans ?? []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (tgUser?.id) fetchProfile(tgUser.id);
  }, [tgUser, fetchProfile]);

  // ── Scan ───────────────────────────────────────────────────────────────────
  const handleScan = async () => {
    if (!ticker.trim() || !tgUser) return;
    setError("");
    setResult(null);
    setLoading(true);

    try {
      const res = await fetch(`${API}/api/sentiment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim(), telegram_id: tgUser.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setError("Daily limit reached. Upgrade to Pro for unlimited scans ⭐");
        } else {
          setError(data.detail ?? "Something went wrong.");
        }
        return;
      }

      setResult(data);
      await fetchProfile(tgUser.id);
      try {
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.HapticFeedback?.impactOccurred("medium");
      } catch { }
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  // ── Payment ────────────────────────────────────────────────────────────────
  const handleUpgrade = async () => {
    if (!tgUser) return;
    setPayLoading(true);
    try {
      const res = await fetch(`${API}/api/pay/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegram_id: tgUser.id,
          chat_id: tgUser.id,  // DM invoice
        }),
      });
      if (res.ok) {
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.close();
      } else {
        setError("Could not create invoice. Try again.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setPayLoading(false);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const isPro = profile?.user?.subscription === "pro";
  const scansLeft = profile?.scans_remaining;

  const labelColor =
    result?.label === "Bullish" ? "#00ff9d"
    : result?.label === "Bearish" ? "#ff3366"
    : "#f5c518";

  return (
    <main
      className="min-h-screen text-white overflow-x-hidden"
      style={{
        background: "#0d0d14",
        backgroundImage: `
          radial-gradient(ellipse 60% 40% at 50% -10%, #1a1a3333 0%, transparent 70%),
          repeating-linear-gradient(0deg, transparent, transparent 39px, #ffffff08 39px, #ffffff08 40px),
          repeating-linear-gradient(90deg, transparent, transparent 39px, #ffffff08 39px, #ffffff08 40px)
        `,
        fontFamily: "'IBM Plex Mono', monospace",
      }}
    >
      {/* ── Top Bar ── */}
      <header className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/5">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#00ff9d] font-mono tracking-[0.3em] uppercase">
              ◈ Sentimental Scout
            </span>
            {isPro && (
              <span className="text-[9px] bg-[#f5c518] text-black px-1.5 py-0.5 rounded font-bold tracking-wider">
                PRO ⭐
              </span>
            )}
          </div>
          <div className="text-[12px] text-[#555] mt-0.5">
            {tgUser ? `${tgUser.first_name}` : "—"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-[#555]">SCANS LEFT</div>
          <div className="text-[13px] font-bold" style={{ color: isPro ? "#f5c518" : "#ccc" }}>
            {scansLeft ?? "—"}
          </div>
        </div>
      </header>

      {/* ── Tabs ── */}
      <div className="flex border-b border-white/5">
        {(["scan", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2.5 text-[11px] font-mono uppercase tracking-widest transition-all"
            style={{
              color: tab === t ? "#00ff9d" : "#444",
              borderBottom: tab === t ? "2px solid #00ff9d" : "2px solid transparent",
              background: "transparent",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Scan Tab ── */}
      {tab === "scan" && (
        <div className="px-4 pt-5 pb-8 space-y-5">
          {/* Search */}
          <div
            className="relative rounded border transition-all"
            style={{ borderColor: loading ? "#00ff9d40" : "#ffffff15" }}
          >
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555] text-xs font-mono">
              $
            </div>
            <input
              ref={inputRef}
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleScan()}
              placeholder="BTC · SOL · ETH · DOGE"
              maxLength={10}
              className="w-full bg-transparent pl-7 pr-20 py-3.5 text-sm font-mono text-white placeholder-[#333] outline-none tracking-widest"
            />
            <button
              onClick={handleScan}
              disabled={loading || !ticker.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 text-[11px] font-mono rounded transition-all"
              style={{
                background: loading ? "transparent" : "#00ff9d",
                color: loading ? "#00ff9d" : "#000",
                border: loading ? "1px solid #00ff9d40" : "none",
                fontWeight: 700,
                letterSpacing: "0.1em",
              }}
            >
              {loading ? (
                <span className="animate-pulse">SCAN</span>
              ) : "SCAN"}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded border border-[#ff3366]/30 bg-[#ff3366]/5 px-4 py-3 text-[12px] text-[#ff3366] font-mono">
              ⚠ {error}
              {error.includes("Upgrade") && !isPro && (
                <button
                  onClick={handleUpgrade}
                  disabled={payLoading}
                  className="ml-3 underline text-[#f5c518]"
                >
                  {payLoading ? "Opening…" : "Upgrade ⭐"}
                </button>
              )}
            </div>
          )}

          {/* Result Card */}
          {result && (
            <div
              className="rounded-lg border p-5 space-y-5"
              style={{
                borderColor: `${result.color}30`,
                background: `linear-gradient(135deg, ${result.color}06 0%, #0d0d14 60%)`,
                boxShadow: `0 0 40px ${result.color}10`,
              }}
            >
              {/* Ticker + label */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold tracking-widest">${result.ticker}</div>
                  <div className="text-[11px] text-[#555] mt-0.5 font-mono">
                    {new Date(result.generated_at * 1000).toLocaleTimeString()}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="text-lg font-bold font-mono"
                    style={{ color: result.color, textShadow: `0 0 12px ${result.color}80` }}
                  >
                    {result.emoji} {result.label}
                  </div>
                  <div className="text-[10px] text-[#555] font-mono mt-0.5 tracking-wider">
                    SENTIMENT INDEX
                  </div>
                </div>
              </div>

              {/* Gauge */}
              <Gauge score={result.score} color={result.color} />

              {/* Divider */}
              <div className="border-t border-white/5 pt-1" />

              {/* Rug warning banner */}
              {result.rug_triggered && (
                <div className="rounded border border-[#ff0055]/40 bg-[#ff0055]/5 px-3 py-2 text-[11px] text-[#ff0055] font-mono">
                  ☠️ RUG-SENSE TRIGGERED — extreme risk detected
                </div>
              )}

              {/* Signals */}
              <div className="space-y-0">
                <SignalRow
                  label="Price 24h"
                  value={`${(result.signals.price_change_24h ?? 0) > 0 ? "+" : ""}${(result.signals.price_change_24h ?? 0).toFixed(2)}%`}
                  bar={clamp(50 + (result.signals.price_change_24h ?? 0) * 2.5, 0, 100)}
                />
                <SignalRow
                  label="Vol/MCap"
                  value={`${(result.signals.vol_mcap_ratio ?? 0).toFixed(2)}%`}
                  bar={clamp((result.signals.vol_mcap_ratio ?? 0) * 5, 0, 100)}
                />
                <SignalRow
                  label="Whale Activity"
                  value={result.signals.whale_activity ?? "—"}
                />
                <SignalRow
                  label="Top Holder"
                  value={`${(result.signals.max_holder_pct ?? 0).toFixed(1)}%`}
                  bar={clamp(100 - (result.signals.max_holder_pct ?? 0) * 4, 0, 100)}
                />
                <SignalRow
                  label="Reddit Buzz"
                  value={result.signals.buzz_level ?? "—"}
                  bar={clamp(50 + (result.signals.social_z_score ?? 0) * 15, 0, 100)}
                />
                <SignalRow
                  label="Social Posts"
                  value={(result.signals.social_volume ?? 0).toLocaleString()}
                  bar={clamp((result.signals.social_volume ?? 0) / 1.2, 0, 100)}
                />
              </div>

              {/* Score breakdown */}
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { label: "Market", score: result.signals.market_score, w: result.signals.weights?.Wm },
                  { label: "On-Chain", score: result.signals.onchain_score, w: result.signals.weights?.Wo },
                  { label: "Social", score: result.signals.social_score, w: result.signals.weights?.Ws },
                ].map(({ label, score, w }) => {
                  const c = (score ?? 0) >= 0 ? "#00ff9d" : "#ff3366";
                  return (
                    <div key={label} className="rounded border border-white/5 bg-white/[0.02] p-2 text-center">
                      <div className="text-[9px] text-[#555] font-mono uppercase tracking-wider">{label}</div>
                      <div className="text-[13px] font-bold font-mono mt-0.5" style={{ color: c }}>
                        {(score ?? 0) > 0 ? "+" : ""}{(score ?? 0).toFixed(0)}
                      </div>
                      <div className="text-[8px] text-[#444] font-mono">W={((w ?? 0) * 100).toFixed(0)}%</div>
                    </div>
                  );
                })}
              </div>

              {/* AI Verdict */}
              {result.reasoning && (
                <div className="rounded border border-white/5 bg-white/[0.02] px-3 py-2.5">
                  <div className="text-[9px] text-[#555] font-mono uppercase tracking-widest mb-1.5">
                    🤖 AI Verdict
                  </div>
                  <p className="text-[11px] text-[#aaa] font-mono leading-relaxed">
                    {result.reasoning}
                  </p>
                </div>
              )}

              {/* Disclaimer */}
              <p className="text-[9px] text-[#333] font-mono text-center leading-relaxed">
                NOT FINANCIAL ADVICE · FOR INFORMATIONAL USE ONLY
              </p>
            </div>
          )}

          {/* Pro CTA */}
          {!isPro && !error && (
            <button
              onClick={handleUpgrade}
              disabled={payLoading}
              className="w-full py-3 rounded border text-[12px] font-mono font-bold uppercase tracking-widest transition-all"
              style={{
                borderColor: "#f5c51840",
                color: "#f5c518",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.background = "#f5c51808";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.background = "transparent";
              }}
            >
              {payLoading ? "Opening Telegram…" : "⭐ Upgrade to Pro · Unlimited Scans"}
            </button>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div className="px-4 pt-5 pb-8 space-y-2">
          <p className="text-[10px] text-[#444] font-mono uppercase tracking-widest mb-4">
            Recent Scans
          </p>
          {scanHistory.length === 0 ? (
            <p className="text-[#333] font-mono text-sm text-center py-10">
              No scans yet. Scan a ticker first.
            </p>
          ) : (
            scanHistory.map((s) => (
              <HistoryRow
                key={s.id}
                ticker={s.ticker}
                label={s.sentiment_label}
                score={s.sentiment_score}
              />
            ))
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="fixed bottom-0 left-0 right-0 border-t border-white/5 bg-[#0d0d14] px-4 py-2 flex justify-between items-center">
        <span className="text-[9px] text-[#333] font-mono">SENTIMENTAL SCOUT v1.0</span>
        <span className="text-[9px] text-[#333] font-mono">
          {isPro ? "⭐ PRO" : `FREE · ${scansLeft ?? 0} scans left`}
        </span>
      </footer>
    </main>
  );
}

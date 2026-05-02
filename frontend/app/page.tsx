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
  partial_data?: boolean;
  warning?: string;
  generated_at: number;
}

interface UserProfile {
  user: {
    telegram_id: number;
    first_name: string;
    subscription: "free" | "pro";
    scans_today: number;
    bonus_scans: number;
  };
  scans_remaining: string | number;
  bonus_scans: number;
  referral_code: string;
  referral_link: string;
  referral_count: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL ?? "https://your-api.onrender.com";

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}
function scoreToAngle(score: number) {
  return (clamp(score, -100, 100) / 100) * 90;
}
function formatScore(score: number) {
  return score > 0 ? `+${score.toFixed(1)}` : score.toFixed(1);
}
function fmtMcap(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toLocaleString()}`;
}

// ── Coin List ─────────────────────────────────────────────────────────────────
const COINS = [
  // Majors
  { ticker: "BTC",    name: "Bitcoin",        emoji: "₿"  },
  { ticker: "ETH",    name: "Ethereum",       emoji: "Ξ"  },
  { ticker: "SOL",    name: "Solana",         emoji: "◎"  },
  { ticker: "BNB",    name: "BNB",            emoji: "🟡" },
  { ticker: "XRP",    name: "Ripple",         emoji: "✕"  },
  { ticker: "ADA",    name: "Cardano",        emoji: "₳"  },
  { ticker: "AVAX",   name: "Avalanche",      emoji: "🔺" },
  { ticker: "DOT",    name: "Polkadot",       emoji: "●"  },
  { ticker: "MATIC",  name: "Polygon",        emoji: "⬡"  },
  { ticker: "LINK",   name: "Chainlink",      emoji: "⬡"  },
  // Memes
  { ticker: "DOGE",   name: "Dogecoin",       emoji: "🐶" },
  { ticker: "SHIB",   name: "Shiba Inu",      emoji: "🐕" },
  { ticker: "PEPE",   name: "Pepe",           emoji: "🐸" },
  { ticker: "WIF",    name: "dogwifhat",      emoji: "🐕" },
  { ticker: "BONK",   name: "Bonk",           emoji: "🔨" },
  { ticker: "FLOKI",  name: "Floki",          emoji: "⚡" },
  { ticker: "POPCAT", name: "Popcat",         emoji: "🐱" },
  { ticker: "TRUMP",  name: "TRUMP",          emoji: "🇺🇸" },
  // Solana ecosystem
  { ticker: "JUP",    name: "Jupiter",        emoji: "🪐" },
  { ticker: "ORCA",   name: "Orca",           emoji: "🐋" },
  { ticker: "RAY",    name: "Raydium",        emoji: "⚡" },
  { ticker: "PYTH",   name: "Pyth Network",   emoji: "🔮" },
  { ticker: "JITO",   name: "Jito",           emoji: "🎯" },
];


function Gauge({ score, color }: { score: number; color: string }) {
  const angle = scoreToAngle(score);
  return (
    <div className="relative w-full flex justify-center items-end" style={{ height: 136 }}>
      <svg viewBox="0 0 200 110" className="w-full max-w-[260px]" overflow="visible">
        <path d="M 20 100 A 80 80 0 0 1 100 20" fill="none" stroke="#ff336618" strokeWidth="20" strokeLinecap="round" />
        <path d="M 100 20 A 80 80 0 0 1 180 100" fill="none" stroke="#00ff9d18" strokeWidth="20" strokeLinecap="round" />
        {score !== 0 && (
          <path
            d={score > 0 ? "M 100 20 A 80 80 0 0 1 180 100" : "M 20 100 A 80 80 0 0 1 100 20"}
            fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
            strokeDasharray="125" strokeDashoffset={125 - Math.abs(score / 100) * 125}
            opacity="0.8" style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)" }}
          />
        )}
        <text x="8"  y="110" fill="#ff3366" fontSize="8" fontFamily="monospace" opacity="0.6">BEAR</text>
        <text x="155" y="110" fill="#00ff9d" fontSize="8" fontFamily="monospace" opacity="0.6">BULL</text>
        <text x="82"  y="14"  fill="#666"    fontSize="7" fontFamily="monospace">NEUTRAL</text>
        {[-90,-60,-30,0,30,60,90].map((deg) => {
          const rad = ((deg-90)*Math.PI)/180;
          return <line key={deg} x1={100+74*Math.cos(rad)} y1={100+74*Math.sin(rad)} x2={100+83*Math.cos(rad)} y2={100+83*Math.sin(rad)} stroke="#333" strokeWidth={deg===0?2:1}/>;
        })}
        <g style={{ transform:`rotate(${angle}deg)`, transformOrigin:"100px 100px", transition:"transform 1.2s cubic-bezier(.34,1.56,.64,1)" }}>
          <line x1="100" y1="100" x2="100" y2="26" stroke={color} strokeWidth="2.5" strokeLinecap="round" style={{ filter:`drop-shadow(0 0 5px ${color})` }}/>
          <polygon points="96,100 104,100 100,88" fill={color} opacity="0.9"/>
        </g>
        <circle cx="100" cy="100" r="6" fill="#0a0a12" stroke={color} strokeWidth="2" style={{ filter:`drop-shadow(0 0 4px ${color})` }}/>
      </svg>
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-3xl font-bold font-mono tracking-tight"
        style={{ color, textShadow:`0 0 18px ${color}70`, transition:"color 0.5s" }}>
        {formatScore(score)}
      </div>
    </div>
  );
}

// ── Stat Box ──────────────────────────────────────────────────────────────────
function StatBox({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{
      borderRadius: 10, border: "1px solid rgba(255,255,255,0.07)",
      background: "rgba(255,255,255,0.03)", padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 3,
    }}>
      <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.15em" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: accent ?? "#e0e0e0", lineHeight: 1.2 }}>{value}</span>
      {sub && <span style={{ fontSize: 9, color: "#444", fontFamily: "monospace" }}>{sub}</span>}
    </div>
  );
}

// ── Bar Row ───────────────────────────────────────────────────────────────────
function BarRow({ label, value, bar, accent }: { label: string; value: string; bar?: number; accent?: string }) {
  const pct = bar !== undefined ? clamp(bar, 0, 100) : undefined;
  const barColor = accent ?? (pct !== undefined ? (pct > 60 ? "#00ff9d" : pct > 35 ? "#f5c518" : "#ff3366") : "#555");
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
      <span style={{ fontSize:10, color:"#555", fontFamily:"monospace", textTransform:"uppercase", letterSpacing:"0.12em", width:70, flexShrink:0 }}>{label}</span>
      <div style={{ display:"flex", alignItems:"center", gap:8, flex:1, justifyContent:"flex-end" }}>
        {pct !== undefined && (
          <div style={{ width:52, height:2, background:"rgba(255,255,255,0.1)", borderRadius:2, overflow:"hidden" }}>
            <div style={{ width:`${pct}%`, height:"100%", background:barColor, borderRadius:2, transition:"width 0.8s ease" }}/>
          </div>
        )}
        <span style={{ fontSize:11, fontFamily:"monospace", color: accent ?? "#bbb" }}>{value}</span>
      </div>
    </div>
  );
}

// ── Score Pill ────────────────────────────────────────────────────────────────
function ScorePill({ label, score, weight }: { label: string; score: number; weight: number }) {
  const c = score >= 0 ? "#00ff9d" : "#ff3366";
  const pct = clamp(50 + score / 2, 0, 100);
  return (
    <div style={{ borderRadius:10, border:"1px solid rgba(255,255,255,0.07)", background:"rgba(255,255,255,0.03)",
      padding:"10px 8px", display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
      <span style={{ fontSize:8, color:"#555", fontFamily:"monospace", textTransform:"uppercase", letterSpacing:"0.12em" }}>{label}</span>
      <span style={{ fontSize:15, fontWeight:700, fontFamily:"monospace", color:c, textShadow:`0 0 10px ${c}60` }}>
        {score > 0 ? "+" : ""}{score.toFixed(0)}
      </span>
      <div style={{ width:"100%", height:2, background:"rgba(255,255,255,0.1)", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:c, transition:"width 0.8s ease" }}/>
      </div>
      <span style={{ fontSize:8, color:"#444", fontFamily:"monospace" }}>W·{(weight*100).toFixed(0)}%</span>
    </div>
  );
}

// ── History Row ───────────────────────────────────────────────────────────────
function HistoryRow({ ticker, label, score, time }: { ticker: string; label: string; score: number; time?: string }) {
  const color = label === "Bullish" ? "#00ff9d" : label === "Bearish" ? "#ff3366" : label === "Extreme Risk" ? "#ff0055" : "#f5c518";
  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg border border-white/[0.07] bg-white/[0.02]">
      <div>
        <span className="font-mono text-sm text-white font-bold">${ticker}</span>
        {time && <div className="text-[9px] text-[#444] font-mono mt-0.5">{time}</div>}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px]" style={{ color }}>{label}</span>
        <span className="font-mono text-xs text-[#444] bg-white/5 px-2 py-0.5 rounded">{formatScore(score)}</span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [tgUser, setTgUser]       = useState<{ id: number; first_name: string } | null>(null);
  const [profile, setProfile]     = useState<UserProfile | null>(null);
  const [ticker, setTicker]       = useState("");
  const [result, setResult]       = useState<SentimentResult | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [tab, setTab]             = useState<"scan" | "history">("scan");
  const [scanHistory, setScanHistory] = useState<any[]>([]);
  const [payLoading, setPayLoading]   = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const init = async () => {
      try {
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.ready(); WebApp.expand();
        WebApp.setHeaderColor("#0a0a12");
        WebApp.setBackgroundColor("#0a0a12");
        const u = WebApp.initDataUnsafe?.user;
        if (u) setTgUser({ id: u.id, first_name: u.first_name ?? "Trader" });
      } catch {
        setTgUser({ id: 999999999, first_name: "Dev" });
      }
    };
    init();
  }, []);

  const fetchProfile = useCallback(async (id: number) => {
    try {
      const res = await fetch(`${API}/api/user/${id}`);
      if (res.ok) {
        const data: UserProfile = await res.json();
        setProfile(data);
        setScanHistory((data as any).recent_scans ?? []);
      }
    } catch {}
  }, []);

  useEffect(() => { if (tgUser?.id) fetchProfile(tgUser.id); }, [tgUser, fetchProfile]);

  const handleScan = async () => {
    if (!ticker.trim() || !tgUser) return;
    setError(""); setResult(null); setLoading(true);
    try {
      const res = await fetch(`${API}/api/sentiment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim(), telegram_id: tgUser.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(res.status === 429 ? "Daily limit reached. Upgrade to Pro for unlimited scans ⭐" : (data.detail ?? "Something went wrong."));
        return;
      }
      setResult(data);
      await fetchProfile(tgUser.id);
      try { const { default: W } = await import("@twa-dev/sdk"); W.HapticFeedback?.impactOccurred("medium"); } catch {}
    } catch { setError("Network error. Check your connection."); }
    finally { setLoading(false); }
  };

  const handleUpgrade = async () => {
    if (!tgUser) return;
    setPayLoading(true);
    try {
      const res = await fetch(`${API}/api/pay/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegram_id: tgUser.id, chat_id: tgUser.id }),
      });
      if (res.ok) { const { default: W } = await import("@twa-dev/sdk"); W.close(); }
      else setError("Could not create invoice. Try again.");
    } catch { setError("Network error."); }
    finally { setPayLoading(false); }
  };

  const isPro     = profile?.user?.subscription === "pro";
  const scansLeft = profile?.scans_remaining;

  return (
    <main className="min-h-screen text-white overflow-x-hidden pb-16"
      style={{ background:"#0a0a12", fontFamily:"'IBM Plex Mono', monospace" }}>

      {/* Grid bg */}
      <div className="fixed inset-0 pointer-events-none" style={{
        backgroundImage:`repeating-linear-gradient(0deg,transparent,transparent 39px,#ffffff05 39px,#ffffff05 40px),repeating-linear-gradient(90deg,transparent,transparent 39px,#ffffff05 39px,#ffffff05 40px)`,
      }}/>

      {/* ── Header ── */}
      <header className="relative z-10 flex items-center justify-between px-4 pt-5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#00ff9d] font-mono tracking-[0.25em] uppercase font-bold">🔮 Oracle</span>
            {isPro && <span className="text-[8px] bg-[#f5c518] text-black px-1.5 py-0.5 rounded-sm font-bold tracking-wider">PRO</span>}
          </div>
          <div className="text-[11px] text-[#444] mt-0.5">{tgUser?.first_name ?? "—"}</div>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-right">
          <div className="text-[8px] text-[#444] font-mono uppercase tracking-widest">Scans left</div>
          <div className="text-[14px] font-bold font-mono" style={{ color: isPro ? "#f5c518" : "#ccc" }}>
            {scansLeft ?? "—"}
          </div>
        </div>
      </header>

      {/* ── Tabs ── */}
      <div className="relative z-10 flex mx-4 mb-4 rounded-lg border border-white/[0.07] bg-white/[0.02] overflow-hidden">
        {(["scan","history"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="flex-1 py-2.5 text-[10px] font-mono uppercase tracking-widest transition-all"
            style={{ color: tab===t ? "#00ff9d" : "#444", background: tab===t ? "#00ff9d0d" : "transparent",
              borderRight: t==="scan" ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Scan Tab ── */}
      {tab === "scan" && (
        <div className="relative z-10 px-4 space-y-3">

          {/* Search box + dropdown */}
          <div style={{ position: "relative" }} ref={dropdownRef}>
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center overflow-hidden"
              style={{ borderColor: loading ? "#00ff9d30" : showDropdown ? "#00ff9d20" : undefined }}>
              <span className="pl-4 text-[#444] font-mono text-sm">$</span>
              <input ref={inputRef} type="text" value={ticker}
                onChange={e => { setTicker(e.target.value.toUpperCase()); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                onKeyDown={e => {
                  if (e.key === "Enter") { setShowDropdown(false); handleScan(); }
                  if (e.key === "Escape") setShowDropdown(false);
                }}
                placeholder="Search or pick a coin…" maxLength={10}
                className="flex-1 bg-transparent px-2 py-3.5 text-sm font-mono text-white placeholder-[#2a2a2a] outline-none tracking-widest"/>
              {ticker && (
                <button onClick={() => { setTicker(""); setShowDropdown(true); inputRef.current?.focus(); }}
                  style={{ color:"#444", fontSize:14, padding:"0 8px", background:"none", border:"none", cursor:"pointer" }}>✕</button>
              )}
              <button onClick={() => { setShowDropdown(false); handleScan(); }} disabled={loading || !ticker.trim()}
                className="mx-2 my-1.5 px-4 py-2 text-[11px] font-mono font-bold rounded-md transition-all"
                style={{ background: loading || !ticker.trim() ? "transparent" : "#00ff9d",
                  color: loading || !ticker.trim() ? "#00ff9d40" : "#000",
                  border: loading ? "1px solid #00ff9d20" : "none", letterSpacing:"0.1em" }}>
                {loading ? <span className="animate-pulse">···</span> : "SCAN"}
              </button>
            </div>

            {/* Dropdown */}
            {showDropdown && !loading && (() => {
              const filtered = ticker.trim()
                ? COINS.filter(c =>
                    c.ticker.includes(ticker.toUpperCase()) ||
                    c.name.toUpperCase().includes(ticker.toUpperCase())
                  )
                : COINS;
              if (filtered.length === 0) return null;
              return (
                <div style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
                  background: "#0f0f1a", border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 10, zIndex: 50, overflow: "hidden",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                  maxHeight: 260, overflowY: "auto",
                }}>
                  {/* Section labels */}
                  {!ticker.trim() && (
                    <div style={{ padding: "8px 14px 4px", fontSize: 8, color: "#444",
                      fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.15em" }}>
                      Popular
                    </div>
                  )}
                  {filtered.map((coin, i) => {
                    const isMajor = ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","LINK"].includes(coin.ticker);
                    const showMemesLabel = !ticker.trim() && i === 10;
                    const showSolLabel   = !ticker.trim() && i === 18;
                    return (
                      <div key={coin.ticker}>
                        {showMemesLabel && (
                          <div style={{ padding: "8px 14px 4px", fontSize: 8, color: "#444",
                            fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.15em",
                            borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                            Memecoins
                          </div>
                        )}
                        {showSolLabel && (
                          <div style={{ padding: "8px 14px 4px", fontSize: 8, color: "#444",
                            fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.15em",
                            borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                            Solana Ecosystem
                          </div>
                        )}
                        <button
                          onClick={() => { setTicker(coin.ticker); setShowDropdown(false); }}
                          style={{
                            width: "100%", display: "flex", alignItems: "center", gap: 12,
                            padding: "10px 14px", background: "transparent", border: "none",
                            cursor: "pointer", textAlign: "left",
                            borderBottom: "1px solid rgba(255,255,255,0.03)",
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                        >
                          <span style={{ fontSize: 16, width: 24, textAlign: "center" }}>{coin.emoji}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontFamily: "monospace", color: "#e0e0e0", fontWeight: 700 }}>
                              ${coin.ticker}
                            </div>
                            <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", marginTop: 1 }}>
                              {coin.name}
                            </div>
                          </div>
                          <span style={{
                            fontSize: 8, fontFamily: "monospace", padding: "2px 6px", borderRadius: 4,
                            background: isMajor ? "rgba(0,255,157,0.08)" : "rgba(245,197,24,0.08)",
                            color: isMajor ? "#00ff9d" : "#f5c518",
                          }}>
                            {isMajor ? "MAJOR" : "MEME"}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {/* Tap outside to close dropdown */}
          {showDropdown && (
            <div style={{ position: "fixed", inset: 0, zIndex: 40 }}
              onClick={() => setShowDropdown(false)} />
          )}

          {/* Error */}
          {error && (
            <div style={{ borderRadius:10, border:"1px solid rgba(255,51,102,0.2)",
              background:"rgba(255,51,102,0.05)", padding:"12px 16px" }}>
              <div style={{ fontSize:11, color:"#ff3366", fontFamily:"monospace", marginBottom: error.includes("scans") ? 8 : 0 }}>
                ⚠ {error}
              </div>
              {error.includes("scans") && !isPro && (
                <div style={{ display:"flex", gap:8, marginTop:4 }}>
                  <button onClick={async () => {
                    if (!profile) return;
                    try {
                      const { default: WebApp } = await import("@twa-dev/sdk");
                      const shareText = `🔮 OnChain Oracle — AI crypto sentiment analysis\n\nWhale tracking · Rug-Sense · AI verdicts\n\nJoin free 👇`;
                      WebApp.openTelegramLink(
                        `https://t.me/share/url?url=${encodeURIComponent(profile.referral_link)}&text=${encodeURIComponent(shareText)}`
                      );
                    } catch {}
                  }}
                    style={{ flex:1, borderRadius:8, background:"rgba(0,255,157,0.1)",
                      border:"1px solid rgba(0,255,157,0.2)", padding:"7px",
                      fontFamily:"monospace", fontSize:10, color:"#00ff9d", cursor:"pointer" }}>
                    Share for +5 scans 🔗
                  </button>
                  <button onClick={handleUpgrade} disabled={payLoading}
                    style={{ flex:1, borderRadius:8, background:"rgba(245,197,24,0.1)",
                      border:"1px solid rgba(245,197,24,0.2)", padding:"7px",
                      fontFamily:"monospace", fontSize:10, color:"#f5c518", cursor:"pointer" }}>
                    {payLoading ? "…" : "Go Pro ⭐"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 space-y-3 animate-pulse">
              <div className="h-4 w-24 bg-white/10 rounded"/>
              <div className="h-28 bg-white/5 rounded-lg"/>
              <div className="grid grid-cols-2 gap-2">
                {[1,2,3,4].map(i => <div key={i} className="h-12 bg-white/5 rounded-lg"/>)}
              </div>
            </div>
          )}

          {/* Result Card */}
          {result && !loading && (
            <div className="rounded-xl border p-4 space-y-4"
              style={{ borderColor:`${result.color}25`, background:`linear-gradient(160deg,${result.color}08 0%,#0a0a12 55%)`,
                boxShadow:`0 0 50px ${result.color}0c` }}>

              {/* Header row */}
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-bold tracking-widest text-white">${result.ticker}</div>
                  <div className="text-[10px] text-[#444] font-mono mt-0.5">
                    {new Date(result.generated_at*1000).toLocaleTimeString()} · {result.signals.tier ?? "—"}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-2 text-right"
                  style={{ borderColor:`${result.color}30`, background:`${result.color}08` }}>
                  <div className="text-[16px] font-bold font-mono" style={{ color:result.color, textShadow:`0 0 14px ${result.color}80` }}>
                    {result.emoji} {result.label}
                  </div>
                  <div className="text-[8px] text-[#555] font-mono tracking-widest mt-0.5">SENTIMENT</div>
                </div>
              </div>

              {/* Gauge */}
              <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] py-3">
                <Gauge score={result.score} color={result.color}/>
              </div>

              {/* Rug banner */}
              {result.rug_triggered && (
                <div className="rounded-lg border border-[#ff0055]/30 bg-[#ff0055]/05 px-4 py-2.5 flex items-center gap-2">
                  <span className="text-[14px]">☠️</span>
                  <span className="text-[11px] text-[#ff0055] font-mono font-bold">RUG-SENSE TRIGGERED — extreme risk detected</span>
                </div>
              )}

              {/* Partial data warning */}
              {result.partial_data && (
                <div style={{ borderRadius:10, border:"1px solid rgba(245,197,24,0.2)",
                  background:"rgba(245,197,24,0.04)", padding:"8px 14px",
                  display:"flex", alignItems:"center", gap:8 }}>
                  <span>⚠️</span>
                  <span style={{ fontSize:10, color:"#f5c518", fontFamily:"monospace" }}>
                    Some data sources unavailable — results may be partial
                  </span>
                </div>
              )}

              {/* Quick stats grid */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                <StatBox label="Price 24h"
                  value={`${(result.signals.price_change_24h??0)>0?"+":""}${(result.signals.price_change_24h??0).toFixed(2)}%`}
                  accent={(result.signals.price_change_24h??0)>=0?"#00ff9d":"#ff3366"}/>
                <StatBox label="Market Cap" value={fmtMcap(result.signals.market_cap_usd??0)}/>
                <StatBox label="Vol/MCap" value={`${(result.signals.vol_mcap_ratio??0).toFixed(2)}%`}
                  sub="liquidity ratio"/>
                <StatBox label="Top Holder"
                  value={`${(result.signals.max_holder_pct??0).toFixed(1)}%`}
                  accent={(result.signals.max_holder_pct??0)>15?"#ff0055":(result.signals.max_holder_pct??0)>8?"#f5c518":"#00ff9d"}
                  sub={(result.signals.max_holder_pct??0)>15?"⚠ rug risk":undefined}/>
              </div>

              {/* Signal bars */}
              <div style={{ borderRadius:10, border:"1px solid rgba(255,255,255,0.07)", background:"rgba(255,255,255,0.02)", padding:"4px 16px" }}>
                <BarRow label="Whale"    value={result.signals.whale_activity??"—"}/>
                <BarRow label="Reddit"   value={result.signals.buzz_level??"—"}
                  bar={clamp(50+(result.signals.social_z_score??0)*15,0,100)}/>
                <BarRow label="Posts"    value={(result.signals.social_volume??0).toLocaleString()}
                  bar={clamp((result.signals.social_volume??0)/1.2,0,100)}/>
                <BarRow label="TXs"      value={(result.signals.large_tx_count??0).toLocaleString()}/>
              </div>

              {/* Score breakdown */}
              <div>
                <div style={{ fontSize:9, color:"#444", fontFamily:"monospace", textTransform:"uppercase", letterSpacing:"0.15em", marginBottom:8 }}>Score Breakdown</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                  <ScorePill label="Market"   score={result.signals.market_score??0}  weight={result.signals.weights?.Wm??0}/>
                  <ScorePill label="On-Chain" score={result.signals.onchain_score??0} weight={result.signals.weights?.Wo??0}/>
                  <ScorePill label="Social"   score={result.signals.social_score??0}  weight={result.signals.weights?.Ws??0}/>
                </div>
              </div>

              {/* AI verdict */}
              {result.reasoning && (
                <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-4 py-3">
                  <div className="text-[8px] text-[#444] font-mono uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    <span>🤖</span><span>AI Verdict</span>
                  </div>
                  <p className="text-[11px] text-[#999] font-mono leading-relaxed">{result.reasoning}</p>
                </div>
              )}

              <p className="text-[8px] text-[#2a2a2a] font-mono text-center">NOT FINANCIAL ADVICE · INFORMATIONAL USE ONLY</p>
            </div>
          )}

          {/* Referral Card */}
          {!isPro && profile && (
            <div style={{ borderRadius:12, border:"1px solid rgba(0,255,157,0.12)",
              background:"rgba(0,255,157,0.03)", padding:"14px 16px" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:11, color:"#00ff9d", fontFamily:"monospace", fontWeight:700 }}>
                    🔗 Share & Earn
                  </div>
                  <div style={{ fontSize:9, color:"#555", fontFamily:"monospace", marginTop:2 }}>
                    +5 scans per referral · {profile.referral_count ?? 0} referred so far
                  </div>
                </div>
                {(profile.bonus_scans ?? 0) > 0 && (
                  <div style={{ borderRadius:8, background:"rgba(0,255,157,0.08)",
                    border:"1px solid rgba(0,255,157,0.15)", padding:"4px 10px", textAlign:"center" }}>
                    <div style={{ fontSize:14, fontFamily:"monospace", fontWeight:700, color:"#00ff9d" }}>
                      +{profile.bonus_scans}
                    </div>
                    <div style={{ fontSize:8, color:"#555", fontFamily:"monospace" }}>bonus</div>
                  </div>
                )}
              </div>

              {/* Referral code display */}
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                <div style={{ flex:1, borderRadius:8, border:"1px solid rgba(255,255,255,0.07)",
                  background:"rgba(255,255,255,0.02)", padding:"8px 12px",
                  fontFamily:"monospace", fontSize:12, color:"#888", letterSpacing:"0.1em" }}>
                  {profile.referral_code ?? "—"}
                </div>
                <button
                  onClick={async () => {
                    try {
                      const { default: WebApp } = await import("@twa-dev/sdk");
                      const shareText = `🔮 OnChain Oracle — AI crypto sentiment analysis\n\nWhale tracking · Rug-Sense · AI verdicts\n\nJoin free 👇`;
                      WebApp.openTelegramLink(
                        `https://t.me/share/url?url=${encodeURIComponent(profile.referral_link)}&text=${encodeURIComponent(shareText)}`
                      );
                    } catch {
                      await navigator.clipboard?.writeText(profile.referral_link);
                    }
                  }}
                  style={{ borderRadius:8, background:"#00ff9d", border:"none",
                    padding:"8px 14px", fontFamily:"monospace", fontSize:11,
                    fontWeight:700, color:"#000", cursor:"pointer", whiteSpace:"nowrap" }}>
                  Share 🔗
                </button>
              </div>

              <div style={{ fontSize:9, color:"#333", fontFamily:"monospace" }}>
                Each friend who joins via your link = +5 scans for you
              </div>
            </div>
          )}

          {/* Pro CTA */}
          {!isPro && (
            <button onClick={handleUpgrade} disabled={payLoading}
              className="w-full py-3.5 rounded-lg border text-[11px] font-mono font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              style={{ borderColor:"#f5c51830", color:"#f5c518", background:"#f5c5180a" }}>
              <span>⭐</span>
              <span>{payLoading ? "Opening Telegram…" : "Upgrade to Oracle Pro · Unlimited Scans"}</span>
            </button>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div className="relative z-10 px-4 space-y-2">
          <div className="text-[9px] text-[#333] font-mono uppercase tracking-widest mb-3">Recent Scans</div>
          {scanHistory.length === 0 ? (
            <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] py-12 text-center">
              <div className="text-[#2a2a2a] font-mono text-sm">No scans yet</div>
              <button onClick={() => setTab("scan")} className="mt-3 text-[10px] text-[#00ff9d] font-mono underline">
                Run your first scan →
              </button>
            </div>
          ) : (
            scanHistory.map((s) => (
              <HistoryRow key={s.id} ticker={s.ticker} label={s.sentiment_label}
                score={s.sentiment_score}
                time={new Date(s.created_at).toLocaleString()}/>
            ))
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="fixed bottom-0 left-0 right-0 border-t border-white/[0.05] bg-[#0a0a12]/95 backdrop-blur px-4 py-2.5 flex justify-between items-center z-20">
        <span className="text-[8px] text-[#2a2a2a] font-mono">ONCHAIN ORACLE v1.0</span>
        <span className="text-[8px] font-mono" style={{ color: isPro ? "#f5c518" : "#333" }}>
          {isPro ? "⭐ PRO — UNLIMITED" : `FREE · ${scansLeft ?? 0} SCANS/DAY`}
        </span>
      </footer>
    </main>
  );
}

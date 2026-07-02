import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";
import {
  Thermometer, Droplets, Wind, Gauge, Radio, RefreshCw,
  CircleDot, ArrowUpRight, BookText, LayoutDashboard, Check, CalendarClock,
} from "lucide-react";

/* ============================================================================
   안흥 AWS(583) 매분자료(nph-aws2_min) → 보정기온/습도/풍속/불쾌지수
   방문자는 아무 설정도 하지 않는다. 인증키·지점·파라미터는 서버(/api/aws)가 주입.
   산출식·방법은 "산출근거" 탭에 명시.
============================================================================ */

const LAT = 37.4646, LON = 128.1551, STD_MERIDIAN = 135.0;
const C = { b0: 0.2125, bT: 1.0224, bS: 6.2558, bU: -0.2027, bR: -0.5365 };
const API = "/api/aws";      // 서버 프록시 (키는 서버에만 존재)
const FCST_API = "/api/forecast"; // 단기예보 프록시
const REFRESH_SEC = 60;
const FCST_REFRESH_SEC = 600; // 단기예보는 1~3시간 간격 발표라 10분마다면 충분

const COL = {
  bg0: "#E2E8F0",      // 전체 배경 (살짝 무게감 있는 회색으로 흰색 카드와 명확한 대비)
  bg1: "#F8FAFC",      // 화면 중앙부 배경 (밝고 시원한 느낌)
  panel: "#FFFFFF",    // 카드 배경 (완전 흰색으로 텍스트를 가장 돋보이게 함)
  panelHi: "#F1F5F9",  // 버튼 및 표 헤더 배경 (구분감 추가)
  line: "#CBD5E1",     // 뚜렷한 테두리 및 구분선
  lineSoft: "#E2E8F0", // 내부 연한 구분선
  text: "#0F172A",     // 메인 텍스트 (거의 검은색에 가까운 네이비, 가독성 최상)
  mut: "#475569",      // 보조 텍스트 (기존보다 훨씬 진하게 높여 또렷하게 보임)
  mut2: "#64748B",     // 가장 작은 텍스트/차트 축 (충분히 읽히는 진한 회색)
  heat: "#DC2626",     // 보정기온 (기상청 특유의 시인성 높은 빨강)
  heatSoft: "#FEE2E2", // 온도 배경 효과 (아주 연한 빨강)
  raw: "#334155",      // 원시 데이터 (차분하고 진한 슬레이트 톤)
  aqua: "#0284C7",     // 습도/메인 컬러 (기상청 스타일의 선명한 파랑)
  sage: "#16A34A",     // 풍속/강수 (안정적이고 뚜렷한 녹색)
  thi: [
    "#0284C7", // 0: 낮음 (파랑)
    "#16A34A", // 1: 보통 (초록)
    "#EA580C", // 2: 높음 (주황 - 노랑은 배경에 묻히므로 주황으로 대체)
    "#DC2626", // 3: 매우 높음 (빨강)
  ],
};

// ---- 태양 기하 ----
function dayOfYear(y, mo, d) {
  return Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}
function solarS0(y, mo, d, h, mi) {
  const doy = dayOfYear(y, mo, d), fh = h + mi / 60, lat = (LAT * Math.PI) / 180;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (fh - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
    0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const tst = fh * 60 + eqt + 4 * (LON - STD_MERIDIAN);
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  return Math.max(0, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha));
}
function parseTm(tm) {
  const m = tm.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return { y, mo, d, h, mi, key: Date.UTC(y, mo - 1, d, h, mi) };
}
function thiValue(T, RH) { return 0.81 * T + 0.01 * RH * (0.99 * T - 14.3) + 46.3; }
function thiBand(v) {
  if (v < 68) return { i: 0, label: "낮음", note: "쾌적" };
  if (v < 75) return { i: 1, label: "보통", note: "일부 불쾌감" };
  if (v < 80) return { i: 2, label: "높음", note: "50% 불쾌감" };
  return { i: 3, label: "매우 높음", note: "대부분 불쾌감" };
}
function correctSeries(rows) {
  const stamped = rows.map((r) => ({ ...r, p: parseTm(r.tm) })).filter((r) => r.p);
  return stamped.map((r) => {
    const p = r.p;
    const lagKey = p.key - 3600000, dLag = new Date(lagKey);
    const s0lag = solarS0(dLag.getUTCFullYear(), dLag.getUTCMonth() + 1, dLag.getUTCDate(),
      dLag.getUTCHours(), dLag.getUTCMinutes());
    // 직전 1시간 습도: 최근접 관측값
    let rhLag = r.hm, best = Infinity;
    for (const q of stamped) {
      const diff = Math.abs(q.p.key - lagKey);
      if (diff < best) { best = diff; rhLag = q.hm; }
    }
    // 강수 플래그: RE(강수감지)가 유효하면 그것을 우선 사용, 결측이면 API가 직접 제공하는 RN-15m(15분 누적강수)로 대체
    const R = (r.re !== null ? r.re > 0 : r.rn15 > 0) ? 1 : 0;
    const sEffLag = (s0lag * (100 - rhLag)) / 100;
    const tHat = C.b0 + C.bT * r.ta + C.bS * sEffLag + C.bU * r.ws + C.bR * R;
    const thi = thiValue(tHat, r.hm);
    const thiRaw = thiValue(r.ta, r.hm); // 원시 AWS 기온 기준 불쾌지수(비교용, 보정 미적용)
    return {
      ...r, valid: true, tHat, delta: tHat - r.ta, s0lag, rhLag, sEffLag, R,
      solarTerm: C.bS * sEffLag, windTerm: C.bU * r.ws, rainTerm: C.bR * R,
      thi, ...thiBand(thi), thiRaw, thiRawBand: thiBand(thiRaw),
      t: `${p.h}`.padStart(2, "0") + ":" + `${p.mi}`.padStart(2, "0"),
    };
  });
}

// nph-aws2_min(매분자료) 실제 응답 형식 전용 파서.
// 헤더가 "# N. NAME" 번호식이 아니라 "# YYMMDDHHMI STN WD1 WS1 ... TD" 한 줄짜리 컬럼명이므로
// 그 줄을 그대로 찾아 열 이름→위치 맵을 만든다. help=1 고정 요청이라 항상 이 줄이 온다.
const DEFAULT_IDX = { // 실제 확인된 컬럼 순서(위 헤더 그대로)를 기본값으로 사용
  YYMMDDHHMI: 0, STN: 1, WD1: 2, WS1: 3, WDS: 4, WSS: 5, WD10: 6, WS10: 7,
  TA: 8, RE: 9, "RN-15M": 10, "RN-60M": 11, "RN-12H": 12, "RN-DAY": 13, HM: 14, PA: 15, PS: 16, TD: 17,
};
function parseKma(text) {
  const lines = text.split(/\r?\n/);
  let map = null;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln.startsWith("#")) continue;
    const toks = ln.replace(/^#\s*/, "").split(/\s+/);
    if (toks[0].toUpperCase() === "YYMMDDHHMI") {
      map = {};
      toks.forEach((t, i) => { map[t.toUpperCase()] = i; });
      break;
    }
  }
  const idx = map || DEFAULT_IDX;
  const iTM = idx.YYMMDDHHMI, iTA = idx.TA, iWS = idx.WS10 ?? idx.WS1, iHM = idx.HM;
  const iRE = idx.RE, iRN15 = idx["RN-15M"];

  const num = (c, i) => { if (i == null) return null; const v = parseFloat(c[i]); return Number.isNaN(v) || v <= -50 ? null : v; };
  const out = [];
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) continue;
    const c = ln.split(/\s+/);
    const s = c[iTM];
    if (!s || !/^\d{12}/.test(s)) continue;
    const ta = num(c, iTA); if (ta === null) continue;
    const tm = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    const ws = num(c, iWS), hm = num(c, iHM);
    const re = num(c, iRE);           // 0/1, 결측이면 null
    const rn15raw = num(c, iRN15);
    const rn15 = rn15raw === null ? 0 : rn15raw;
    out.push({ tm, ta, ws: ws ?? 0, hm: hm ?? 50, re, rn15 });
  }
  return out.sort((a, b) => parseTm(a.tm).key - parseTm(b.tm).key);
}

const DEMO = [{"tm":"2026-05-31 15:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 16:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 17:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 18:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 19:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 20:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 21:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 22:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-05-31 23:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 00:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 01:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 02:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 03:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 04:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 05:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 06:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 07:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 08:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 09:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 10:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 11:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 12:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 13:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99},{"tm":"2026-06-01 14:00","ta":99,"ws":99,"hm":99,"re":99,"rn15":99}];

// ---- 단기예보(getVilageFcst) 응답 파서 ----
// items를 fcstDate+fcstTime 별로 묶어 TMP/REH/WSD/PTY를 뽑는다.
// re는 예보에 없는 개념이라 null(결측)로 두고, PTY(강수형태)를 rn15 자리에 매핑해
// correctSeries의 기존 R 판정 로직(re가 null이면 rn15로 대체)을 그대로 재사용한다.
function parseForecastJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("예보 응답 파싱 실패"); }
  const header = json?.response?.header;
  if (!header || header.resultCode !== "00") {
    throw new Error(header?.resultMsg || "예보 조회 실패");
  }
  const items = json?.response?.body?.items?.item;
  if (!Array.isArray(items) || !items.length) throw new Error("예보 데이터 없음");

  const byStep = {};
  for (const it of items) {
    const key = `${it.fcstDate}${it.fcstTime}`;
    if (!byStep[key]) byStep[key] = { fcstDate: it.fcstDate, fcstTime: it.fcstTime };
    byStep[key][it.category] = it.fcstValue;
  }
  return Object.values(byStep)
    .filter((s) => s.TMP !== undefined && s.REH !== undefined)
    .map((s) => {
      const tm = `${s.fcstDate.slice(0, 4)}-${s.fcstDate.slice(4, 6)}-${s.fcstDate.slice(6, 8)} ${s.fcstTime.slice(0, 2)}:${s.fcstTime.slice(2, 4)}`;
      return {
        tm,
        ta: parseFloat(s.TMP),
        hm: parseFloat(s.REH),
        ws: s.WSD !== undefined ? parseFloat(s.WSD) : 0,
        re: null,
        rn15: s.PTY !== undefined && s.PTY !== "0" ? 1 : 0,
        pty: s.PTY ?? "0",
        pop: s.POP !== undefined ? parseFloat(s.POP) : null,
      };
    })
    .sort((a, b) => parseTm(a.tm).key - parseTm(b.tm).key);
}

// 실시간 예보를 못 받아올 때 표시할 데모 예보(다음 24시간, 현재 시각 기준 상대 생성)
function buildDemoForecast() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const out = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(start.getTime() + i * 3600 * 1000);
    const h = d.getHours();
    const ta = Math.round((15 + 9 * Math.sin(Math.PI * (h - 5) / 15)) * 10) / 10;
    const hm = Math.round(85 - 45 * Math.max(0, Math.sin(Math.PI * (h - 5) / 15)));
    const rainy = h === 17 || h === 18;
    const p = (n) => String(n).padStart(2, "0");
    out.push({
      tm: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(h)}:00`,
      ta: 99, hm: 99, ws: 99, re: null,
      rn15: 99, pty: "99", pop: 99,
    });
  }
  return out;
}
const DEMO_FCST = buildDemoForecast();

// ============================================================================
export default function App() {
  const [page, setPage] = useState("main");
  const [rows, setRows] = useState(DEMO);
  const [status, setStatus] = useState({ state: "init", msg: "불러오는 중…" });
  const [fetching, setFetching] = useState(true); // 요청이 진행 중인 동안만 true — 갱신 중 숫자 흐림 처리에 사용
  const timer = useRef(null);

  const [fcstRows, setFcstRows] = useState(DEMO_FCST);
  const [fcstStatus, setFcstStatus] = useState({ state: "init", msg: "예보 불러오는 중…" });
  const fcstTimer = useRef(null);

  const fetchLive = useCallback(async () => {
    setFetching(true);
    setStatus((s) => ({ state: s.state === "live" ? "live" : "loading", msg: "관측값 갱신 중…" }));
    try {
      const res = await fetch(API, { headers: { Accept: "text/plain" } });
      if (!res.ok) throw new Error(`서버 ${res.status}`);
      const text = await res.text();
      const parsed = parseKma(text);
      if (!parsed.length) throw new Error("관측 행 없음");
      setRows(parsed);
      setStatus({ state: "live", msg: `실시간 · 최신 ${parsed[parsed.length - 1].tm} KST` });
    } catch (e) {
      setRows(DEMO);
      setStatus({ state: "demo", msg: `실시간 대기 중 (${e.message}) · 데모 표시` });
    } finally {
      setFetching(false);
    }
  }, []);

  const fetchForecast = useCallback(async () => {
    try {
      const res = await fetch(FCST_API, { headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new Error(`서버 ${res.status}`);
      const parsed = parseForecastJson(text);
      setFcstRows(parsed);
      setFcstStatus({ state: "live", msg: `단기예보 · 발표 최신` });
    } catch (e) {
      setFcstRows(DEMO_FCST);
      setFcstStatus({ state: "demo", msg: `예보 대기 중 (${e.message}) · 데모 표시` });
    }
  }, []);

  useEffect(() => {
  fetchLive();
  }, [fetchLive]);

  useEffect(() => {
  fetchForecast();
  }, [fetchForecast]);

  const series = useMemo(() => correctSeries(rows).filter((r) => r.valid), [rows]);
  const cur = series[series.length - 1];
  const fcstSeries = useMemo(() => correctSeries(fcstRows).filter((r) => r.valid), [fcstRows]);

  const dot = status.state === "demo" ? COL.sage : status.state === "live" ? COL.thi[0] : COL.mut;

  return (
    <div style={{ minHeight: "100%", background: `radial-gradient(1200px 600px at 78% -8%, ${COL.bg1}, ${COL.bg0} 62%)`, color: COL.text, fontFamily: "'IBM Plex Sans KR', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css');


        .mono{font-variant-numeric:tabular-nums}
        .card{background:${COL.panel};border:1px solid ${COL.line};border-radius:16px}
        .eyebrow{letter-spacing:.22em;text-transform:uppercase;font-size:10.5px;font-weight:600;color:${COL.mut}}
        .btn{border:1px solid ${COL.line};background:${COL.panelHi};color:${COL.text};border-radius:10px;cursor:pointer;transition:.15s}
        .btn:hover{border-color:${COL.aqua}}
        .pulse{animation:pl 2s ease-in-out infinite}@keyframes pl{0%,100%{opacity:1}50%{opacity:.35}}
        @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .rise{animation:rise .5s ease both}
        .navtab{cursor:pointer;display:inline-flex;align-items:center;gap:7px;padding:7px 13px;font-size:13px;font-weight:600;transition:.15s}
        @media (prefers-reduced-motion:reduce){.pulse,.rise{animation:none}}
        @media (max-width:720px){.hero-grid,.two-grid{grid-template-columns:1fr !important}}
      `}</style>

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "26px 22px 48px" }}>
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14, marginBottom: 18 }}>
          <div>
            <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Radio size={13} style={{ color: COL.aqua }} /> 실시간 반영 · AWS 583
            </div>
            <h1 style={{ margin: "7px 0 2px", fontSize: 27, fontWeight: 700, letterSpacing: "-.01em" }}>
              민족사관고등학교 <span style={{ color: COL.mut, fontWeight: 400 }}>날씨</span>
            </h1>
            <div className="mono" style={{ fontSize: 12, color: COL.mut2 }}>
              안흥 AWS - 37.4646°N · 128.1551°E · 해발 530 m
            </div>
          </div>
          {page === "main" && (
            <button className="btn" onClick={fetchLive} title="새로고침" style={{ padding: 8 }}>
              <RefreshCw size={15} className={status.state === "loading" ? "pulse" : ""} />
            </button>
          )}
        </header>

        <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: `1px solid ${COL.line}`, paddingBottom: 2 }}>
          <div className="navtab" onClick={() => setPage("main")}
            style={{ color: page === "main" ? COL.text : COL.mut, borderBottom: `2px solid ${page === "main" ? COL.aqua : "transparent"}` }}>
            <LayoutDashboard size={14} /> 실황
          </div>
          <div className="navtab" onClick={() => setPage("method")}
            style={{ color: page === "method" ? COL.text : COL.mut, borderBottom: `2px solid ${page === "method" ? COL.aqua : "transparent"}` }}>
            <BookText size={14} /> 산출근거
          </div>
        </div>

        {page === "main"
          ? <Dashboard series={series} cur={cur} status={status} dot={dot} loading={fetching}
              fcstSeries={fcstSeries} fcstStatus={fcstStatus} />
          : <Methodology cur={cur} />}
      </div>
    </div>
  );
}

// ============================================================================
function Dashboard({ series, cur, status, dot, loading, fcstSeries, fcstStatus }) {
  if (!cur) return <div style={{ padding: 40, color: COL.text }}>데이터를 불러오는 중…</div>;
  const chart = series, band = COL.thi[cur.i];
  const dim = { opacity: loading ? 0.32 : 1, transition: "opacity .35s ease" };
  const N = (real) => (loading ? "99" : real); // 갱신 중엔 숫자를 99로 표시
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 18, fontSize: 12.5 }}>
        <CircleDot size={12} className={status.state === "live" ? "pulse" : ""} style={{ color: dot }} />
        <span style={{ color: COL.mut }}>{status.msg}</span>
      </div>

      <div className="hero-grid" style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card rise" style={{ padding: "22px 24px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(420px 220px at 85% 0%, ${COL.heatSoft}, transparent 70%)`, pointerEvents: "none" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
            <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Thermometer size={13} style={{ color: COL.heat }} /> 보정기온
            </div>
            <div className="mono" style={{ fontSize: 12, color: COL.mut2 }}>{cur.tm} KST</div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 18, marginTop: 14, position: "relative" }}>
            <div className="mono" style={{ fontSize: 66, fontWeight: 600, lineHeight: 0.9, color: COL.heat, letterSpacing: "-.02em", ...dim }}>
              {N(cur.tHat.toFixed(1))}<span style={{ fontSize: 26, color: COL.mut }}>°C</span>
            </div>
            <div style={{ paddingBottom: 8, ...dim }}>
              <div className="mono" style={{ fontSize: 13, color: COL.raw }}>원시 AWS {N(cur.ta.toFixed(1))}°C</div>
              <div className="mono" style={{ fontSize: 13, color: cur.delta >= 0 ? COL.heat : COL.aqua, display: "flex", alignItems: "center", gap: 3, marginTop: 2 }}>
                <ArrowUpRight size={13} style={{ transform: cur.delta < 0 ? "scaleY(-1)" : "none" }} />
                보정 {loading ? "99" : `${cur.delta >= 0 ? "+" : ""}${cur.delta.toFixed(2)}`}°C
              </div>
            </div>
          </div>
          <div style={{ marginTop: 18, position: "relative" }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>보정 성분</div>
            <DeltaBar label="일사 지연" value={cur.solarTerm} color={COL.heat} max={4} loading={loading} />
            <DeltaBar label="통풍(풍속)" value={cur.windTerm} color={COL.aqua} max={4} loading={loading} />
            <DeltaBar label="강수" value={cur.rainTerm} color={COL.sage} max={4} loading={loading} />
          </div>
        </div>

        <div className="card rise" style={{ padding: "22px 24px" }}>
          <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Gauge size={13} style={{ color: band }} /> 불쾌지수 · 보정기온 기준
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: 14 }}>
            <div className="mono" style={{ fontSize: 60, fontWeight: 600, lineHeight: 0.9, color: band, letterSpacing: "-.02em", ...dim }}>
              {N(cur.thi.toFixed(1))}
            </div>
            <div style={{ paddingBottom: 9, ...dim }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: band }}>{cur.label}</div>
              <div style={{ fontSize: 12, color: COL.mut }}>{cur.note}</div>
            </div>
          </div>
          <div style={dim}><ThiGauge value={cur.thi} /></div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${COL.lineSoft}`, display: "flex", alignItems: "center", justifyContent: "space-between", ...dim }}>
            <div style={{ fontSize: 11.5, color: COL.mut2 }}>
              원시 AWS 기준 <span style={{ color: COL.mut }}>(보정 미적용)</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span className="mono" style={{ fontSize: 18, fontWeight: 600, color: COL.raw }}>
                {N(cur.thiRaw.toFixed(1))}
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: COL.thi[cur.thiRawBand.i] }}>
                {cur.thiRawBand.label}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="two-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Metric icon={<Droplets size={13} />} accent={COL.aqua} label="습도" sub="AWS 관측" value={cur.hm} unit="%" bar={cur.hm} loading={loading} />
        <Metric icon={<Wind size={13} />} accent={COL.sage} label="풍속" sub="AWS 관측" value={cur.ws.toFixed(1)} unit="m/s" bar={Math.min(100, (cur.ws / 8) * 100)} loading={loading} />
      </div>

      <div className="card rise" style={{ padding: "18px 20px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div className="eyebrow">최근 추이</div>
          <div style={{ display: "flex", gap: 14, fontSize: 11.5 }}>
            <Legend c={COL.raw} t="원시 AWS" /><Legend c={COL.heat} t="보정" /><Legend c={band} t="불쾌지수" />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={COL.lineSoft} vertical={false} />
            <XAxis dataKey="t" tick={{ fill: COL.mut2, fontSize: 10, fontFamily: "IBM Plex Mono" }} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: COL.line }} />
            <YAxis yAxisId="l" tick={{ fill: COL.mut2, fontSize: 10, fontFamily: "IBM Plex Mono" }} tickLine={false} axisLine={false} width={40} />
            <YAxis yAxisId="r" orientation="right" domain={[55, 90]} hide />
            <Tooltip contentStyle={{ background: COL.bg0, border: `1px solid ${COL.line}`, borderRadius: 10, fontSize: 12, fontFamily: "IBM Plex Mono" }} labelStyle={{ color: COL.mut }} />
            <ReferenceLine yAxisId="r" y={68} stroke={COL.thi[1]} strokeDasharray="3 3" strokeOpacity={0.4} />
            <ReferenceLine yAxisId="r" y={75} stroke={COL.thi[2]} strokeDasharray="3 3" strokeOpacity={0.4} />
            <Line yAxisId="l" type="monotone" dataKey="ta" name="원시" stroke={COL.raw} strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
            <Line yAxisId="l" type="monotone" dataKey="tHat" name="보정" stroke={COL.heat} strokeWidth={2.4} dot={false} />
            <Line yAxisId="r" type="monotone" dataKey="thi" name="불쾌지수" stroke={band} strokeWidth={1.4} dot={false} strokeOpacity={0.55} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <ForecastSection series={fcstSeries} status={fcstStatus} />

      <p style={{ fontSize: 11, color: COL.mut2, marginTop: 16, textAlign: "center" }}>
        습도·풍속은 AWS 원값, 불쾌지수는 보정기온으로 산정. 사용한 모든 식은 <span style={{ color: COL.aqua }}>산출근거</span> 탭 참조.
      </p>
    </>
  );
}

// ============================================================================
function Methodology({ cur }) {
  const ex = cur;
  return (
    <div className="rise" style={{ maxWidth: 820 }}>
      <p style={{ color: COL.mut, fontSize: 13.5, lineHeight: 1.7, marginBottom: 26 }}>
        이 대시보드가 표출하는 보정기온과 불쾌지수의 산출식·계수·방법을 모두 명시합니다.
        아래 계산 예시는 현재 표출값(<span className="mono" style={{ color: COL.text }}>{ex ? ex.tm : "-"}</span>)을 그대로 대입한 것입니다.
      </p>

      <Sec n="01" title="데이터 출처와 대상">
        <ul style={ulS}>
          <li>입력: 기상청 API허브 <b>안흥 AWS(583) 매분자료</b> <span className="mono">nph-aws2_min</span> (기온·풍속·습도·강수). 서버가 매 요청마다 최근 구간(tm1~tm2)을 자동 계산해 조회합니다. 인증키는 서버에만 저장되며 방문자 설정은 필요 없습니다.</li>
          <li>지점: 위도 37.4646°N, 경도 128.1551°E, 해발 530 m, 표준자오선 135°E(KST).</li>
          <li>추정 대상: 현장 관측소 기온(<b>DS18B20 · 지상 80 cm · 간이백엽상</b>).</li>
          <li>표출 습도·풍속은 보정 없이 <b>AWS 원값</b> 사용(현장 DHT22 습도센서의 포화·드리프트 한계로 습도 보정은 미적용).</li>
        </ul>
      </Sec>

      <Sec n="02" title="보정기온 — 회귀식 (Model D)">
        <F>{String.raw`\hat{T} = 0.2125 + 1.0224 \cdot T_a + 6.2558 \cdot S_{\text{eff}}(t-1\text{h}) - 0.2027 \cdot U - 0.5365 \cdot R`}</F>
        <Tbl rows={[
          ["Ta", "AWS 기온 (°C)", "기준 기온"],
          ["S_eff(t−1h)", "직전 1시간 실효일사(아래 03)", "80cm 근지표 초단열 + 간이백엽상 일사 가열, 오후 열지연 반영"],
          ["U", "AWS 풍속 WS10, 10분 평균 (m/s)", "통풍에 의한 냉각 (계수 음)"],
          ["R", "강수 플래그", "최근 강수량>0 → 1, 아니면 0 (증발냉각 보정)"],
        ]} />
        <p style={pS}>선형최소자승 적합. 직전 1시간 일사를 쓰는 이유는 관측소 과열이 정오가 아니라 오후 15~16시에 최대가 되는 열지연 때문입니다.</p>
      </Sec>

      <Sec n="03" title="실효일사 지수 S_eff 와 청천일사 S0">
        <F>{String.raw`S_{\text{eff}} = S_0 \cdot \frac{100 - \text{RH}}{100}`}</F>
        <F>{String.raw`S_0 = \max(0, \cos \theta_z), \quad \cos \theta_z = \sin \varphi \cdot \sin \delta + \cos \varphi \cdot \cos \delta \cdot \cos h`}</F>
        <ul style={ulS}>
          <li>φ = 위도. δ = 태양 적위, h = 시간각 — Spencer/NOAA 근사식(적위·균시차 포함).</li>
          <li>시간각은 진태양시(TST) = 시각(분) + 균시차 + 4·(경도 − 135°). KST 벽시계 기준.</li>
          <li>(100 − RH)/100 은 구름 대리변수 — 습할수록 유효 일사를 낮춤.</li>
          <li>지연항 S_eff(t−1h): 최근접 1시간 전 관측의 S_eff. 결손 시 0.</li>
        </ul>
      </Sec>

      <Sec n="04" title="불쾌지수 (Thom THI)">
        <p style={{ ...pS, marginTop: 0 }}>섭씨형(RH 단위 %):</p>
        <F>{String.raw`\text{THI} = 0.81 \cdot T + 0.01 \cdot \text{RH} \cdot (0.99 \cdot T - 14.3) + 46.3`}</F>
        <p style={pS}>화씨형(RH 단위 분율, 위 식과 대수적으로 동일):</p>
        <F>{String.raw`\text{THI} = \left(\frac{9}{5} \cdot T + 32\right) - 0.55 \cdot (1 - \text{RH}) \cdot \left(\frac{9}{5} \cdot T - 26\right)`}</F>
        <ul style={ulS}>
          <li>두 식은 완전히 같은 값을 줍니다. 단 화씨형은 <b>RH를 분율(0~1)</b>, 섭씨형은 <b>%</b>로 넣습니다.</li>
          <li>메인 화면의 큰 숫자는 입력 T에 <b>보정기온 T̂</b>를 사용한 값이고, 그 아래 작게 병기된 값은 입력 T에 <b>원시 AWS 기온</b>을 그대로 쓴 값(보정 미적용)입니다. RH는 두 경우 모두 AWS 습도를 사용합니다.</li>
        </ul>
      </Sec>

      <Sec n="05" title="불쾌지수 단계 (기상청 기준)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
          {[["낮음", "68 미만", 0], ["보통", "68 – 75", 1], ["높음", "75 – 80", 2], ["매우 높음", "80 이상", 3]].map(([l, r, i]) => (
            <div key={l} style={{ border: `1px solid ${COL.line}`, borderLeft: `3px solid ${COL.thi[i]}`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontWeight: 700, color: COL.thi[i], fontSize: 14 }}>{l}</div>
              <div className="mono" style={{ fontSize: 12, color: COL.mut }}>{r}</div>
            </div>
          ))}
        </div>
      </Sec>

      <Sec n="06" title="결측·강수 플래그 처리">
        <ul style={ulS}>
          <li>현장 센서 −127(DS18B20 통신실패), 85(파워온 기본값)은 결측 제외.</li>
          <li>매분자료 응답은 값이 −50 이하면 결측/에러로 처리합니다(기상청 안내 기준).</li>
          <li>매분 응답의 열 위치는 <span className="mono">YYMMDDHHMI STN WD1 WS1 ... TD</span> 헤더 줄을 그대로 읽어 자동 인식합니다.</li>
          <li>강수 플래그 R: <span className="mono">RE</span>(강수감지 0/1)가 유효하면 그 값을 우선 사용하고, 결측이면 API가 직접 제공하는 <span className="mono">RN-15m</span>(15분 누적강수)이 0보다 큰지로 대체 판정합니다.</li>
          <li>풍속 U는 <span className="mono">WS10</span>(10분 평균풍속)을 사용합니다 — 원 보정식이 시간평균 풍속으로 적합되어, 1분 순간값(WS1)보다 노이즈가 적은 10분 평균이 계수의 의미에 더 가깝습니다.</li>
        </ul>
      </Sec>

      <Sec n="07" title="검증 성능 (학습 구간 2026-03-09 ~ 06-01)">
        <Tbl head={["방법", "MAE", "RMSE", "R²"]} rows={[
          ["무보정 (T̂ = Ta)", "1.34 °C", "1.91", "—"],
          ["Model D (5-fold CV)", "0.83 °C", "1.12", "0.982"],
          ["Model D (미래 30% 검증)", "0.88 °C", "1.22", "—"],
        ]} />
        <p style={pS}>DS18B20은 경시 드리프트가 없어 계수가 시간에 안정적입니다(잔차 표준편차 0.21 °C). 학습이 초봄~초여름이라 한여름·겨울 확장 시 계절 자료로 재검증을 권장합니다.</p>
      </Sec>

      <Sec n="08" title="단기예보 적용 (getVilageFcst)">
        <ul style={ulS}>
          <li>기상청 API허브 <span className="mono">VilageFcstInfoService_2.0/getVilageFcst</span>(단기예보)에서 <span className="mono">TMP</span>(1시간 기온) · <span className="mono">REH</span>(습도) · <span className="mono">WSD</span>(풍속) · <span className="mono">PTY</span>(강수형태)를 가져와, 실황과 같은 보정식·불쾌지수식을 그대로 적용합니다.</li>
          <li>격자좌표는 안흥 위경도(37.4646°N, 128.1551°E)를 기상청 공식 LCC(람베르트 정각원추) 격자변환식으로 계산한 <b>nx=80, ny=125</b>입니다. 변환식은 서울시청(37.5665°N, 126.9780°E → 60,127)이라는 공개된 기준값으로 정확도를 검증했습니다.</li>
          <li>발표시각(base_date/base_time)은 단기예보 발표 스케줄(02·05·08·11·14·17·20·23시, 발표 후 약 10분 뒤 조회 가능)에 맞춰 서버가 매 요청마다 자동으로 가장 최근 발표를 계산합니다.</li>
          <li>강수 플래그 R은 <span className="mono">PTY</span>(0:없음 1:비 2:비/눈 3:눈 4:소나기)가 0이 아니면 1로 판정합니다 — 실황의 RE/RN-15m과 같은 역할을 예보에서는 PTY가 대신합니다.</li>
          <li>2021년 6월부터 단기예보 예보단위가 3시간→1시간으로 세분화되어, 실황과 동일한 "직전 1시간 일사" 지연항을 예보에도 그대로 적용할 수 있습니다.</li>
          <li>표에는 <b>보정기온 · 기온(원본) · 불쾌지수(보정) · 불쾌지수(원본)</b> 네 값을 함께 표시해, 예보 시점에도 보정 효과를 바로 비교할 수 있게 했습니다.</li>
        </ul>
      </Sec>

      {ex && (
        <Sec n="09" title="현재값 대입 예시">
          <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.9, color: COL.mut, background: COL.bg0, border: `1px solid ${COL.line}`, borderRadius: 12, padding: "16px 18px" }}>
            <div>입력: Ta={ex.ta.toFixed(1)}°C · U(WS10)={ex.ws.toFixed(1)} m/s · RH={ex.hm}% · RE={ex.re === null ? "결측" : ex.re} · RN-15m={ex.rn15.toFixed(1)}mm → R={ex.R}</div>
            <div>S0(t−1h)={ex.s0lag.toFixed(3)} · RH(t−1h)={ex.rhLag}% → S_eff(t−1h)={ex.sEffLag.toFixed(3)}</div>
            <div style={{ color: COL.mut2, margin: "6px 0", borderTop: `1px dashed ${COL.line}`, paddingTop: 6 }}>
              T̂ = 0.2125 + 1.0224×{ex.ta.toFixed(1)} + 6.2558×{ex.sEffLag.toFixed(3)} − 0.2027×{ex.ws.toFixed(1)} − 0.5365×{ex.R}
            </div>
            <div style={{ color: COL.heat, fontSize: 14 }}>= {ex.tHat.toFixed(2)} °C &nbsp;(원시 대비 {ex.delta >= 0 ? "+" : ""}{ex.delta.toFixed(2)})</div>
            <div style={{ color: COL.text, marginTop: 8 }}>
              THI(보정) = 0.81×{ex.tHat.toFixed(1)} + 0.01×{ex.hm}×(0.99×{ex.tHat.toFixed(1)} − 14.3) + 46.3
              <span style={{ color: COL.thi[ex.i] }}> = {ex.thi.toFixed(1)} ({ex.label})</span>
            </div>
            <div style={{ color: COL.mut, marginTop: 4 }}>
              THI(원시) = 0.81×{ex.ta.toFixed(1)} + 0.01×{ex.hm}×(0.99×{ex.ta.toFixed(1)} − 14.3) + 46.3
              <span style={{ color: COL.thi[ex.thiRawBand.i] }}> = {ex.thiRaw.toFixed(1)} ({ex.thiRawBand.label})</span>
            </div>
          </div>
        </Sec>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 7, color: COL.mut2, fontSize: 12, marginTop: 8 }}>
        <Check size={13} style={{ color: COL.thi[0] }} /> 표출값은 위 식을 그대로 계산한 결과입니다.
      </div>
    </div>
  );
}

const ulS = { margin: "0", paddingLeft: 18, color: COL.mut, fontSize: 13.5, lineHeight: 1.85 };
const pS = { color: COL.mut, fontSize: 13, lineHeight: 1.7, marginTop: 12 };
function Sec({ n, title, children }) {
  return (
    <section style={{ marginBottom: 30 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <span className="mono" style={{ fontSize: 12, color: COL.aqua, fontWeight: 600 }}>{n}</span>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COL.text }}>{title}</h2>
      </div>
      <div style={{ paddingLeft: 22 }}>{children}</div>
    </section>
  );
}
import { BlockMath } from "react-katex";
import "katex/dist/katex.min.css";
function F({ children }) {
  return (
    <div style={{ 
      background: COL.bg0, 
      border: `1px solid ${COL.line}`, 
      borderLeft: `3px solid ${COL.heat}`, 
      borderRadius: 8, 
      padding: "12px 14px", 
      margin: "8px 0", 
      overflowX: "auto" 
    }}>
      {/* 내부 텍스트를 LaTeX 수식으로 렌더링합니다 */}
      <BlockMath math={children} />
    </div>
  );
}
function Tbl({ head, rows }) {
  return (
    <div style={{ margin: "10px 0", border: `1px solid ${COL.line}`, borderRadius: 10, overflow: "hidden" }}>
      {head && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${head.length},1fr)`, background: COL.panelHi, borderBottom: `1px solid ${COL.line}` }}>
          {head.map((h) => <div key={h} className="eyebrow" style={{ padding: "8px 12px" }}>{h}</div>)}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: head ? `repeat(${head.length},1fr)` : "140px 1fr 1.4fr", borderTop: i ? `1px solid ${COL.lineSoft}` : "none" }}>
          {r.map((c, j) => (
            <div key={j} className={j === 0 ? "mono" : ""} style={{ padding: "9px 12px", fontSize: 12.5, color: j === 0 ? COL.aqua : COL.mut, lineHeight: 1.5 }}>{c}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
function ForecastSection({ series, status }) {
  if (!series || !series.length) return null;
  const rows = series.slice(0, 24); // 다음 24시간
  const dim = { opacity: status.state === "loading" ? 0.32 : 1, transition: "opacity .35s ease" };
  const ptyLabel = (pty) => ({ "0": "맑음", "1": "비", "2": "비/눈", "3": "눈", "4": "소나기" }[pty] ?? "-");

  return (
    <div className="card rise" style={{ padding: "18px 20px", marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <CalendarClock size={13} style={{ color: COL.aqua }} /> 단기예보 · 다음 24시간
        </div>
        <div style={{ fontSize: 11, color: COL.mut2 }}>{status.msg}</div>
      </div>

      <div style={{ overflowX: "auto", ...dim }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${COL.line}` }}>
              {["예보시각", "보정기온", "기온(원본)", "불쾌지수(보정)", "불쾌지수(원본)", "강수형태"].map((h, i) => (
                <th key={h} className="eyebrow" style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 10px", whiteSpace: "nowrap", ...(i === 0 ? { position: "sticky", left: 0, background: COL.panel, zIndex: 2, boxShadow: `2px 0 4px -2px rgba(0,0,0,.4)` } : {}),}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.tm} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${COL.lineSoft}` : "none" }}>
                <td className="mono" style={{
                  padding: "7px 10px", fontSize: 12.5, color: COL.mut, whiteSpace: "nowrap",
                  position: "sticky", left: 0, background: COL.panel, zIndex: 1, boxShadow: `2px 0 4px -2px rgba(0,0,0,.4)`,
                }}>
                  {r.tm.slice(5, 10)} {r.t}
                </td>
                <td className="mono" style={{ padding: "7px 10px", fontSize: 12.5, textAlign: "right", color: COL.heat, fontWeight: 600 }}>
                  {r.tHat.toFixed(1)}°
                </td>
                <td className="mono" style={{ padding: "7px 10px", fontSize: 12.5, textAlign: "right", color: COL.raw }}>
                  {r.ta.toFixed(1)}°
                </td>
                <td className="mono" style={{ padding: "7px 10px", fontSize: 12.5, textAlign: "right", color: COL.thi[r.i], fontWeight: 600 }}>
                  {r.thi.toFixed(1)}
                </td>
                <td className="mono" style={{ padding: "7px 10px", fontSize: 12.5, textAlign: "right", color: COL.thi[r.thiRawBand.i] }}>
                  {r.thiRaw.toFixed(1)}
                </td>
                <td style={{ padding: "7px 10px", fontSize: 12, textAlign: "right", color: r.pty !== "0" ? COL.aqua : COL.mut2, whiteSpace: "nowrap" }}>
                  {ptyLabel(r.pty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10.5, color: COL.mut2, marginTop: 10 }}>
        기상청 단기예보(안흥 격자 nx=80,ny=125) TMP·REH·WSD·PTY를 실황과 같은 보정식·불쾌지수식에 그대로 적용한 값입니다.
      </p>
    </div>
  );
}
function Legend({ c, t }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: COL.mut }}><span style={{ width: 11, height: 3, borderRadius: 2, background: c }} />{t}</span>;
}
function DeltaBar({ label, value, color, max, loading }) {
  const pct = Math.min(100, (Math.abs(value) / max) * 100);
  const dim = { opacity: loading ? 0.32 : 1, transition: "opacity .35s ease" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, ...dim }}>
      <div style={{ width: 66, fontSize: 11.5, color: COL.mut }}>{label}</div>
      <div style={{ flex: 1, height: 7, background: COL.bg0, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: ".4s" }} />
      </div>
      <div className="mono" style={{ width: 52, textAlign: "right", fontSize: 11.5, color: COL.text }}>
        {loading ? "99" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`}
      </div>
    </div>
  );
}
function Metric({ icon, accent, label, sub, value, unit, bar, loading }) {
  const dim = { opacity: loading ? 0.32 : 1, transition: "opacity .35s ease" };
  return (
    <div className="card rise" style={{ padding: "18px 22px" }}>
      <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ color: accent }}>{icon}</span> {label}
        <span style={{ color: COL.mut2, fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>· {sub}</span>
      </div>
      <div className="mono" style={{ fontSize: 40, fontWeight: 600, marginTop: 10, color: COL.text, ...dim }}>
        {loading ? "99" : value}<span style={{ fontSize: 17, color: COL.mut }}> {unit}</span>
      </div>
      <div style={{ height: 6, background: COL.bg0, borderRadius: 4, overflow: "hidden", marginTop: 10 }}>
        <div style={{ width: `${bar}%`, height: "100%", background: accent, opacity: loading ? 0.32 : 0.8, borderRadius: 4, transition: ".4s" }} />
      </div>
    </div>
  );
}
function ThiGauge({ value }) {
  const lo = 55, hi = 85;
  const pos = Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
  const stops = [
    { p: ((68 - lo) / (hi - lo)) * 100, c: COL.thi[0] },
    { p: ((75 - lo) / (hi - lo)) * 100, c: COL.thi[1] },
    { p: ((80 - lo) / (hi - lo)) * 100, c: COL.thi[2] },
    { p: 100, c: COL.thi[3] },
  ];
  let grad = `linear-gradient(90deg,${COL.thi[0]} 0%`, prev = 0;
  stops.forEach((s) => { grad += `,${s.c} ${prev}%,${s.c} ${s.p}%`; prev = s.p; });
  grad += ")";
  return (
    <div style={{ marginTop: 16, position: "relative" }}>
      <div style={{ height: 10, borderRadius: 6, background: grad }} />
      <div style={{ position: "absolute", top: -3, left: `calc(${pos}% - 8px)`, width: 16, height: 16, borderRadius: "50%", background: "#fff", border: `3px solid ${COL.bg0}`, boxShadow: "0 2px 6px rgba(0,0,0,.5)" }} />
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: COL.mut2, marginTop: 6 }}>
        <span>낮음 68</span><span>보통 75</span><span>높음 80</span><span>매우높음</span>
      </div>
    </div>
  );
}

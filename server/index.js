/**
 * 안흥 AWS(583) 매분자료 + 단기예보(안흥 격자) 프록시 서버
 * - 인증키는 이 서버(.env)에만 저장됩니다. 방문자는 아무것도 설정할 필요가 없습니다.
 * - /api/aws      → nph-aws2_min (매분 실황)
 * - /api/forecast → getVilageFcst (단기예보). nx=80,ny=125는 안흥 좌표(37.4646,128.1551)를
 *   기상청 공식 LCC 격자변환식으로 계산한 값(서울시청 37.5665,126.9780→60,127 기준값으로 검증됨).
 * - 두 API 모두 API허브에서 개별로 "활용신청"이 되어 있어야 하며, 승인된 서비스라면 같은 authKey를 그대로 씁니다.
 */
import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 8787;
const AUTH_KEY = process.env.KMA_AUTH_KEY;           // ★ 인증키: 여기 한 곳(.env)에만 넣으면 끝
const STN = process.env.KMA_STN || "583";             // 안흥 AWS 지점번호
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 180); // 조회 구간(분), 12시간(720) 이내
const FCST_NX = Number(process.env.FCST_NX || 80);    // 안흥 단기예보 격자 X
const FCST_NY = Number(process.env.FCST_NY || 125);   // 안흥 단기예보 격자 Y
const AWS_BASE = "https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min";
const FCST_BASE = "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst";

if (!AUTH_KEY) {
  console.warn(
    "[경고] KMA_AUTH_KEY가 설정되지 않았습니다. .env 파일에 발급받은 인증키를 넣어주세요.\n" +
    "  예) KMA_AUTH_KEY=발급받은_키"
  );
}

// KST(UTC+9) 기준 "YYYYMMDDHHmm" 문자열
function kstStamp(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    kst.getUTCFullYear().toString() +
    p(kst.getUTCMonth() + 1) +
    p(kst.getUTCDate()) +
    p(kst.getUTCHours()) +
    p(kst.getUTCMinutes())
  );
}

// 단기예보는 02,05,08,11,14,17,20,23시(KST)에 발표되고 발표 후 약 10분 뒤 조회 가능.
// 지금 조회 가능한 가장 최근 발표시각(base_date, base_time)을 계산한다.
function latestForecastBase(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const h = kst.getUTCHours(), mi = kst.getUTCMinutes();
  const schedule = [2, 5, 8, 11, 14, 17, 20, 23];
  const nowMin = h * 60 + mi;
  let hour = null;
  for (const sh of schedule) { if (nowMin >= sh * 60 + 10) hour = sh; }
  let y = kst.getUTCFullYear(), mo = kst.getUTCMonth(), d = kst.getUTCDate();
  if (hour === null) {
    hour = 23;
    const prev = new Date(Date.UTC(y, mo, d)); prev.setUTCDate(prev.getUTCDate() - 1);
    y = prev.getUTCFullYear(); mo = prev.getUTCMonth(); d = prev.getUTCDate();
  }
  const p = (n) => String(n).padStart(2, "0");
  return { base_date: `${y}${p(mo + 1)}${p(d)}`, base_time: `${p(hour)}00` };
}

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/aws", async (req, res) => {
  if (!AUTH_KEY) {
    return res.status(500).send("# 서버 설정 오류: KMA_AUTH_KEY가 비어 있습니다 (.env 확인)");
  }
  try {
    const now = new Date();
    const tm2 = kstStamp(now);
    const tm1 = kstStamp(new Date(now.getTime() - WINDOW_MIN * 60 * 1000));

    const url = new URL(AWS_BASE);
    url.searchParams.set("tm1", tm1);
    url.searchParams.set("tm2", tm2);
    url.searchParams.set("stn", STN);
    url.searchParams.set("disp", "0");
    url.searchParams.set("help", "1"); // 프런트가 헤더로 열 위치를 자동 인식하므로 항상 1 유지
    url.searchParams.set("authKey", AUTH_KEY);

    const upstream = await fetchWithTimeout(url.toString());
    const text = await upstream.text();

    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.status(upstream.ok ? 200 : 502).send(text);
  } catch (e) {
    const msg = e.name === "AbortError" ? "기상청 응답 지연(8초 초과)" : e.message;
    res.status(502).send(`# 프록시 오류: ${msg}`);
  }
});

app.get("/api/forecast", async (req, res) => {
  if (!AUTH_KEY) {
    return res.status(500).json({ error: "KMA_AUTH_KEY가 비어 있습니다 (.env 확인)" });
  }
  try {
    const { base_date, base_time } = latestForecastBase(new Date());

    const url = new URL(FCST_BASE);
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("numOfRows", "1000");
    url.searchParams.set("dataType", "JSON");
    url.searchParams.set("base_date", base_date);
    url.searchParams.set("base_time", base_time);
    url.searchParams.set("nx", String(FCST_NX));
    url.searchParams.set("ny", String(FCST_NY));
    url.searchParams.set("authKey", AUTH_KEY);

    const upstream = await fetchWithTimeout(url.toString());
    const text = await upstream.text();

    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.status(upstream.ok ? 200 : 502).send(text);
  } catch (e) {
    const msg = e.name === "AbortError" ? "기상청 응답 지연(8초 초과)" : e.message;
    res.status(502).json({ error: `프록시 오류: ${msg}` });
  }
});

// 프로덕션: 빌드된 프런트엔드(dist)를 같은 서버에서 서빙 → 배포 시 명령 하나로 완결
const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) res.status(404).send("dist/index.html 이 없습니다. 먼저 `npm run build` 를 실행하세요.");
  });
});

app.listen(PORT, () => {
  console.log(`✔ 안흥 관측소 서버 실행 중  http://localhost:${PORT}`);
  console.log(`  /api/aws      → nph-aws2_min (stn=${STN}, window=${WINDOW_MIN}분)`);
  console.log(`  /api/forecast → getVilageFcst (nx=${FCST_NX}, ny=${FCST_NY})`);
});

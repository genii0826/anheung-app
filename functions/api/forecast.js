/**
 * Cloudflare Pages Function: /api/forecast
 * 단기예보(getVilageFcst, 안흥 격자 nx/ny) 프록시.
 * 인증키는 Cloudflare Pages 대시보드 환경변수(KMA_AUTH_KEY)에서 읽습니다.
 */

// 단기예보는 02,05,08,11,14,17,20,23시(KST)에 발표되고, 발표 후 약 10분 뒤 조회 가능.
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

export async function onRequestGet(context) {
  const env = context.env;
  const AUTH_KEY = env.KMA_AUTH_KEY;
  const FCST_NX = Number(env.FCST_NX || 80);
  const FCST_NY = Number(env.FCST_NY || 125);

  if (!AUTH_KEY) {
    return new Response(JSON.stringify({ error: "KMA_AUTH_KEY가 비어 있습니다 (Cloudflare Pages 환경변수 확인)" }), {
      status: 500, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { base_date, base_time } = latestForecastBase(new Date());

  const url = new URL("https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("base_date", base_date);
  url.searchParams.set("base_time", base_time);
  url.searchParams.set("nx", String(FCST_NX));
  url.searchParams.set("ny", String(FCST_NY));
  url.searchParams.set("authKey", AUTH_KEY);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let upstream, text;
    try {
      upstream = await fetch(url.toString(), { signal: controller.signal });
      text = await upstream.text();
    } finally {
      clearTimeout(timer);
    }
    return new Response(text, {
      status: upstream.ok ? 200 : 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e.name === "AbortError" ? "기상청 응답 지연(8초 초과)" : e.message;
    return new Response(JSON.stringify({ error: `프록시 오류: ${msg}` }), {
      status: 502, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

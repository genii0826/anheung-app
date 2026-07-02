/**
 * Cloudflare Pages Function: /api/aws
 * 안흥 AWS(583) 매분자료(nph-aws2_min) 프록시.
 *
 * Pages Functions는 상시 실행 서버(app.listen)가 아니라 요청마다 실행되는
 * Workers 런타임 함수입니다. 인증키는 Cloudflare Pages 대시보드의
 * Settings → Environment variables 에 KMA_AUTH_KEY 로 등록하면
 * context.env.KMA_AUTH_KEY 로 읽어옵니다 — .env 파일이 아닙니다.
 */

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

export async function onRequestGet(context) {
  const env = context.env;
  const AUTH_KEY = env.KMA_AUTH_KEY;
  const STN = env.KMA_STN || "583";
  const WINDOW_MIN = Number(env.WINDOW_MIN || 180);

  if (!AUTH_KEY) {
    return new Response(
      "# 서버 설정 오류: KMA_AUTH_KEY가 비어 있습니다 (Cloudflare Pages → Settings → Environment variables 확인)",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const now = new Date();
  const tm2 = kstStamp(now);
  const tm1 = kstStamp(new Date(now.getTime() - WINDOW_MIN * 60 * 1000));

  const url = new URL("https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min");
  url.searchParams.set("tm1", tm1);
  url.searchParams.set("tm2", tm2);
  url.searchParams.set("stn", STN);
  url.searchParams.set("disp", "0");
  url.searchParams.set("help", "1");
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
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e.name === "AbortError" ? "기상청 응답 지연(8초 초과)" : e.message;
    return new Response(`# 프록시 오류: ${msg}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

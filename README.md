# 안흥 관측소 보정 실황 대시보드

기상청 API허브 안흥 AWS(583) **매분자료**(`nph-aws2_min`)와
**단기예보**(`getVilageFcst`)를 받아 보정기온·습도·풍속·불쾌지수를
실시간/예보 두 가지로 표출합니다.

**인증키는 서버 쪽에 한 번만 넣습니다. 방문자는 아무 설정도 하지 않습니다.**
설정 화면 자체가 없고, 사이트를 열면 바로 실시간 값과 예보가 보입니다.

이 프로젝트는 배포 방식 두 가지를 모두 지원합니다:

| 방식 | 폴더 | 인증키 저장 위치 |
|---|---|---|
| **Cloudflare Pages** (서버리스) | `functions/` | Pages 대시보드 → Environment variables |
| **일반 Node 서버** (VPS 등, 상시 실행) | `server/` | `.env` 파일 |

둘 중 하나만 쓰면 되고, 나머지 폴더는 그냥 무시해도 됩니다.

---

## A) Cloudflare Pages로 배포하기 ★ 추천

Cloudflare Pages는 Express처럼 계속 떠 있는 서버를 못 돌립니다(정적 파일 + 요청마다 실행되는
"Pages Functions"만 지원). 그래서 `server/index.js`(Express) 대신 `functions/api/aws.js`,
`functions/api/forecast.js`를 씁니다 — 로직은 완전히 동일하고, 형태만 Cloudflare Functions 방식입니다.

1. 이 저장소를 GitHub 등에 올리고 Cloudflare Pages에서 연결합니다.
2. **빌드 설정**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - (Root directory는 이 프로젝트 폴더 그대로 — `functions/`가 저장소 루트에 있어야 자동 인식됩니다)
3. **Settings → Environment variables** 에 아래를 추가:
   ```
   KMA_AUTH_KEY = 발급받은_인증키        (필수)
   KMA_STN      = 583                    (선택, 기본값 583)
   WINDOW_MIN   = 180                    (선택)
   FCST_NX      = 80                     (선택)
   FCST_NY      = 125                    (선택)
   ```
   `PORT`는 필요 없습니다(서버리스라 포트 개념이 없습니다).
4. 저장 후 재배포(Redeploy)하면 끝입니다. `/api/aws`, `/api/forecast`가 `functions/` 안의
   함수로 자동 라우팅됩니다 — 프런트엔드 코드는 그대로(상대경로 `/api/...` 호출)라 손댈 게 없습니다.

**흔한 실수**
- Express용 `server/index.js`를 그대로 배포 명령에 넣고 돌리려는 경우 → Pages에서는 동작하지 않습니다. Cloudflare Pages를 쓸 땐 `functions/` 폴더만 있으면 됩니다.
- `.env` 파일을 만들어서 올리는 경우 → Pages Functions는 `.env`를 읽지 않습니다. 반드시 대시보드의 Environment variables에 등록해야 합니다.
- `functions/`가 저장소 루트가 아니라 `src/` 안에 들어가 있는 경우 → 인식되지 않습니다.

---

## B) 일반 Node 서버로 배포하기 (VPS, Render, Railway 등)

```bash
npm install
cp .env.example .env
# .env 파일을 열어 KMA_AUTH_KEY= 뒤에 발급받은 인증키를 붙여넣기

npm run build
npm start
```

→ `http://서버주소:8787` 접속. `server/index.js`(Express)가 `/api/aws`, `/api/forecast`를
프록시하면서 동시에 `dist/`를 정적으로 서빙합니다. 이 방식은 24시간 떠 있는 서버(VPS 등)에서만
동작하고, Cloudflare Pages·Netlify·Vercel 같은 정적/서버리스 호스팅에는 맞지 않습니다.

### 로컬 개발 (핫리로드)

```bash
# 터미널 1: API 프록시
npm run server
# 터미널 2: 프런트엔드 개발서버
npm run dev
```

`vite.config.js`의 dev 프록시가 `/api`를 로컬 express(8787)로 넘기므로 이 파일엔 키가 없습니다.

---

## 공통: 매분자료·단기예보는 각각 별도 활용신청 필요

같은 authKey라도 **`nph-aws2_min`(매분자료)와 `getVilageFcst`(단기예보)는 API허브에서
각각 따로 "활용신청"** 되어 있어야 정상 응답합니다. 하나만 신청돼 있으면 나머지 하나는
자동으로 데모 데이터로 표시됩니다(에러로 화면이 죽지 않습니다).

## 동작 원리 — 실황 (`/api/aws`)

- 프런트엔드는 `/api/aws`를 60초마다 호출합니다. 파라미터도, 키도 프런트에는 없습니다.
- 서버(Pages Function 또는 Express)가 매 요청마다 `tm1`(현재−3시간)·`tm2`(현재)를 KST로 계산해
  `nph-aws2_min?tm1=...&tm2=...&stn=583&disp=0&help=1&authKey=...`를 대신 호출합니다.
- 응답 헤더(`# YYMMDDHHMI STN WD1 WS1 WDS WSS WD10 WS10 TA RE RN-15m RN-60m RN-12H RN-DAY HM PA PS TD`)를
  그대로 읽어 컬럼 위치를 자동 인식합니다. 헤더가 없을 경우를 대비해 이 확인된 순서를 기본값으로도 갖고 있습니다.
- 기온은 `TA`, 풍속은 `WS10`(10분 평균), 강수 플래그는 `RE`가 유효하면 그 값을, 결측이면
  `RN-15m`(15분 누적강수)을 대신 씁니다.
- 실시간 호출이 실패하면 자동으로 데모 데이터로 전환됩니다(현재는 확인용으로 전부 `99`로 채워 둠 —
  `src/AnheungStationDashboard.jsx`의 `DEMO` 배열에서 원하는 값으로 바꿀 수 있습니다).

## 동작 원리 — 단기예보 (`/api/forecast`)

- 프런트엔드는 `/api/forecast`를 10분마다 호출합니다.
- 서버가 단기예보 발표 스케줄(02·05·08·11·14·17·20·23시, 발표 후 약 10분 뒤 조회 가능)에 맞춰
  가장 최근 `base_date`/`base_time`을 자동 계산하고, `getVilageFcst?...&nx=80&ny=125&authKey=...`를
  대신 호출합니다.
- `nx=80, ny=125`는 안흥 좌표(37.4646°N, 128.1551°E)를 기상청 공식 LCC 격자변환식으로 계산한 값입니다
  (서울시청 37.5665°N,126.9780°E → 60,127이라는 공개된 기준값으로 변환식 정확도를 검증했습니다).
- `TMP`·`REH`·`WSD`·`PTY`를 시간대별로 묶어 실황과 **같은 보정식·불쾌지수식**을 그대로 적용하고,
  **보정기온 · 기온(원본) · 불쾌지수(보정) · 불쾌지수(원본)** 네 값을 표로 보여줍니다.
- 예보 호출이 실패하면 자동으로 데모 예보(현재 시각 기준 다음 24시간)로 전환됩니다.

## 조회 구간 제한

기상청 안내상 매분자료는 지점 1개 기준 **최대 12시간(720분)**까지 조회 가능합니다.
기본값 `WINDOW_MIN=180`(3시간)은 보정식의 1시간 지연항 계산에 여유를 두면서도 응답 크기를
적절히 유지합니다.

## 파일 구성

```
anheung-app/
├─ functions/                 ← ★ Cloudflare Pages용 (서버리스)
│  └─ api/
│     ├─ aws.js                /api/aws  — 매분 실황 프록시
│     └─ forecast.js           /api/forecast — 단기예보 프록시
├─ server/                    ← ★ 일반 Node 서버용 (VPS 등, 상시 실행)
│  └─ index.js                 Express로 위 두 라우트 + dist/ 정적 서빙
├─ .env.example                일반 Node 서버용 (Pages는 대시보드 환경변수 사용)
├─ package.json
├─ vite.config.js              개발용 프록시(키 없음)
├─ index.html
└─ src/
   ├─ main.jsx
   └─ AnheungStationDashboard.jsx   대시보드 본체 (실황/산출근거 2페이지 + 단기예보 표)
```

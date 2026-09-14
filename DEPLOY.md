# 배포 가이드 — 정적 파일과 게임 서버 분리

## 왜 나누는가

이 게임은 Socket.io로 **지속 연결(WebSocket)** 을 유지하면서 서버 메모리에 방/봇/게임
상태를 들고 있다. Vercel은 요청이 끝나면 함수가 종료되는 서버리스 플랫폼이라 이 구조를
그대로 올릴 수 없다.

그래서 둘로 나눈다.

| 무엇 | 어디에 | 왜 |
| --- | --- | --- |
| 정적 파일 (HTML/JS/3D 에셋) | Vercel | CDN으로 빠르게, 무료로 서빙 |
| 게임 서버 (`server.js`) | Render 등 상시 실행 호스트 | WebSocket 지속 연결 필요 |

로컬 개발은 지금까지처럼 `npm start` 하나로 전부 돌아간다. 분리는 배포에만 적용된다.

---

## 1. 게임 서버 배포 (Render)

1. Render 대시보드 → **New → Blueprint** → 이 저장소 연결
2. 저장소 루트의 `render.yaml` 이 자동으로 읽힌다 (`npm install` → `npm start`, 헬스체크 `/health`)
3. 배포가 끝나면 주소를 받는다. 예: `https://market-raid.onrender.com`
4. 브라우저로 `https://<주소>/health` 를 열어 확인한다:

```json
{ "ok": true, "rooms": 0, "protocol": "ravenwood-entry-1",
  "commit": "1c979d2", "branch": "main", "startedAt": "..." }
```

`commit` 과 `branch` 가 **지금 main 의 최신 커밋과 같아야** 화면(Vercel)과
게임 서버가 같은 버전이다. 예전에 이 둘이 어긋나서 시작 위치와 문 이벤트가
전부 이상해진 적이 있는데, 그때는 무엇이 떠 있는지 알 방법이 없었다.
다르면 Render 대시보드에서 **Manual Deploy → Deploy latest commit** 을 누른다.

> **free 플랜 주의**: 15분간 접속이 없으면 슬립 상태가 되고 그때 열려 있던 WebSocket
> 연결이 끊긴다. 다시 깨어나는 데 약 1분 걸린다. 친구들끼리 가끔 접속하는 용도로는
> 충분하지만, 상시 운영에는 유료 플랜이 필요하다.

## 2. 정적 파일 배포 (Vercel)

1. Vercel에서 이 저장소를 Import
2. **Framework Preset**: `Other` (루트의 `vercel.json` 이 빌드 설정을 이미 갖고 있다.
   처음 화면에서 Express가 잡혀 있으면 Other로 바꾼다)
3. **Environment Variables** 에 추가:

   | Key | Value |
   | --- | --- |
   | `GAME_SERVER_URL` | `https://market-raid.onrender.com` (1번에서 받은 주소) |

4. Deploy

빌드는 `npm run build:static` 이 돌면서:
- `public/` → `dist/` (아래 "배포에서 제외되는 것" 참고)
- `node_modules/three` 의 `build`, `examples/jsm` → `dist/vendor/three/`
  (로컬에서 `server.js` 가 서빙하는 `/vendor/three` 와 같은 경로라 import 경로가 양쪽에서 동일하다)
- `GAME_SERVER_URL` 값을 `dist/js/server-url.js` 에 주입

`GAME_SERVER_URL` 을 빼먹으면 빌드 로그에 경고가 찍히고, 클라이언트가 same-origin으로
접속을 시도하다 실패한다 (Vercel 쪽엔 Socket.io 서버가 없으므로).

### 배포에서 제외되는 것

`public/assets/low_poly_market_stalls/` (144MB)는 `stall-wood.glb` 로 변환하기 전의
**원본 소스 에셋**이라 게임이 불러오지 않는다. 저장소에는 남겨두되 배포 결과물에서는
빼도록 `scripts/build-static.mjs` 의 `EXCLUDE` 에 등록해 뒀다. 덕분에 배포 크기가
170MB → 27MB 로 줄어든다.

나중에 다른 원본 에셋을 `public/` 에 두게 되면 같은 `EXCLUDE` 배열에 추가하면 된다.

---

## 3. 클라이언트에서 서버 주소 쓰기

`public/js/server-url.js` 가 주소를 하나로 관리한다. 접속 코드는 이렇게 쓴다:

```js
import { SERVER_URL } from './server-url.js';

// SERVER_URL 이 '' 이면 same-origin (로컬 개발), 값이 있으면 그 주소로 (분리 배포)
const socket = SERVER_URL ? io(SERVER_URL) : io();
```

Socket.io 클라이언트 라이브러리는 게임 서버가 `/socket.io/socket.io.js` 로 서빙하므로,
분리 배포에서는 절대 경로로 불러와야 한다:

```html
<script src="https://market-raid.onrender.com/socket.io/socket.io.js"></script>
```

서버의 CORS는 이미 `origin: '*'` 로 열려 있어 별도 설정이 필요 없다.

### three.js import map

`public/js/assets.js` 는 `'three'`, `'three/addons/...'` 같은 bare import를 쓴다.
브라우저에서 동작하려면 진입 HTML에 import map이 있어야 한다:

```html
<script type="importmap">
{
  "imports": {
    "three": "/vendor/three/build/three.module.js",
    "three/addons/": "/vendor/three/examples/jsm/"
  }
}
</script>
```

이 경로는 로컬(`server.js` 서빙)과 배포(`dist/vendor/three/`) 양쪽에서 동일하다.

---

## 현재 상태

서버와 클라이언트 모두 동작한다. 방 만들기 → 참가 → 작전 개시 → 이동/사격/장전 →
폭발물 해체 → 결과까지 2인 접속으로 확인했다.

남은 것은 **3D 모델**이다. `public/assets/models/` 에 있는 건 `stall-wood.glb` 하나뿐이라
나머지 9개(`stall-tarp`, `crate`, `barrel`, `vase`, `well`, `character`,
`weapon-rifle`, `weapon-smg`, `weapon-sniper`)는 `config.js` 의 placeholder 도형으로
대체돼 그려진다. 게임은 정상 동작하지만 상자·통·사람·총이 단순 도형으로 보인다.
파일을 넣으면 코드 수정 없이 자동으로 바뀐다.

GLB 를 넣은 뒤에는 `config.js` 의 `VIEWMODEL` 값을 다시 맞춰야 한다. 지금 값은
임시 총 모델 크기에 맞춰 둔 것이다.

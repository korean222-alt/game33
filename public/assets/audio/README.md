# 소리 파일 넣는 곳

이 폴더는 비어 있어도 게임이 돌아간다. 기본 소리는 전부 그 자리에서 합성한다.
다만 **사람 목소리**(고함 · 비명 · 항복)는 합성으로는 한계가 뚜렷하다. 성대와
입 모양을 흉내 낼 수는 있어도 "사람이 지른 소리"로는 들리지 않는다.

여기에 녹음 파일을 넣으면 그 소리만 녹음으로 바뀐다. 하나만 넣어도 된다.

## 넣는 방법

1. 아래 이름표에 맞는 파일을 이 폴더에 넣는다. 파일 이름은 자유다.
   폴더로 나눠 넣어도 된다. (`voice/shout-1.ogg` 처럼)
2. `npm run import:audio` 를 돌린다. 폴더를 훑어서 `manifest.json` 을 만든다.
3. 끝. 게임을 켜면 그 소리부터 쓴다.

이름을 맞추기 어려우면 파일 이름에 이름표를 넣어 두면 된다. 예를 들어
`shout-01.ogg`, `voice-scream-2.mp3` 처럼 두면 자동으로 알맞은 자리에 들어간다.

## 이름표

| 이름표 | 언제 나는 소리 | 몇 개까지 |
|---|---|---|
| `voice/shout` | 내가 구두 경고를 외칠 때 (V / 경고 버튼) | 여러 개 |
| `voice/scream` | 크게 맞았을 때의 비명 | 여러 개 |
| `voice/pain` | 조금 맞았을 때의 신음 | 여러 개 |
| `voice/death` | 쓰러질 때 | 여러 개 |
| `voice/panic` | 민간인이 겁먹은 소리 | 여러 개 |
| `voice/surrender` | 용의자가 항복할 때 | 여러 개 |
| `voice/defy` | 경고를 무시하고 덤빌 때 | 여러 개 |
| `voice/cuffed` | 수갑을 채울 때의 항의 | 여러 개 |
| `voice/contact` | 용의자가 나를 발견하고 외칠 때 | 여러 개 |
| `voice/cough` | 가스를 마셨을 때 | 여러 개 |
| `gun/rifle` `gun/smg` `gun/sniper` | 총성 | 여러 개 |
| `gun/reload` | 장전 (길이는 총에 맞춰 늘고 준다) | 1개 권장 |
| `door/open` `door/close` `door/kick` `door/unlock` | 문 | 여러 개 |
| `gear/cuff` | 수갑 채우는 소리 | 여러 개 |
| `grenade/flash` `grenade/gas` `grenade/frag` | 투척물 | 여러 개 |
| `player/hurt` | 내가 맞았을 때의 충격 | 여러 개 |

같은 이름표에 파일을 여럿 넣으면 그중 하나를 무작위로 고른다. 같은 비명이
반복될 때 티가 덜 난다.

## 형식

`.ogg` `.mp3` `.wav` `.m4a` 를 읽는다. 브라우저 호환은 `.ogg`(안드로이드·PC)와
`.m4a`/`.mp3`(아이폰)가 가장 넓다. **둘 다 지원하려면 `.mp3` 가 가장 무난하다.**

- 길이: 목소리 0.3~1.5초, 총성 0.3초 안쪽
- 앞뒤의 빈 구간(무음)은 잘라 낸다. 안 자르면 총을 쏘고 한 박자 뒤에 소리가 난다.
- 한 파일 1MB 아래를 권한다.

## 받을 곳 (저작권 확인 필수)

아래는 상업적 이용까지 가능한 무료 자료가 많은 곳이다. **CC0 / Public Domain**
표시가 있는 것을 고르면 출처 표기 없이 쓸 수 있다. CC-BY 는 출처를 적어야
하므로 `public/credits.html` 에 추가한다.

- **freesound.org** — 가장 많다. 검색창 옆 필터에서 라이선스를 `Creative
  Commons 0` 으로 고른다. 검색어: `male shout`, `pain grunt`, `male scream`,
  `handcuffs`, `door kick`, `rifle shot`, `magazine reload`
- **pixabay.com/sound-effects/** — 전부 무료, 출처 표기 없이 사용 가능.
  검색어: `shout`, `scream`, `grunt`, `gun shot`, `door slam`
- **opengameart.org** — 게임용. 라이선스가 항목마다 적혀 있다.
- **kenney.nl/assets** (Impact Sounds, Sci-Fi Sounds 등) — 전부 CC0.
- **sonniss.com/gameaudiogdc** — 매년 공개되는 대용량 무료 묶음. 상업적 사용 가능.

한국어 고함이 필요하면 직접 녹음하는 편이 가장 빠르고 확실하다. 휴대폰 녹음기로
"경찰이다! 무기 버려!" 를 몇 번 외쳐서 넣으면 된다.

## 다시 빼려면

파일을 지우고 `npm run import:audio` 를 다시 돌린다. 목록에서 빠지면 그 소리는
다시 합성음으로 돌아간다.

# 캐릭터 모델 안내 — 인질 · 납치범 · 대원

## 한눈에

| 역할 | 파일 | 넣는 명령 |
| --- | --- | --- |
| 대원(우리 팀) | `character-officer.glb` | `node scripts/swap-character.mjs --role officer <파일>` |
| 납치범(용의자·주범) | `character-suspect.glb` | `node scripts/swap-character.mjs --role suspect <파일>` |
| 인질·민간인 | `character-hostage.glb` | `node scripts/swap-character.mjs --role hostage <파일>` |
| 전부 한꺼번에 | `character-animated.glb` | `node scripts/swap-character.mjs <파일>` |

역할별 파일은 **없어도 된다.** 안 넣은 역할은 기본 캐릭터
(`character-animated.glb`)를 그대로 쓴다. 그래서 인질 모델 하나만 받아서
넣어도 인질만 바뀐다. 동작 16개는 기본 캐릭터의 것을 공유하므로 새로 받을
필요가 없다.

넣고 난 뒤에는 항상:

```sh
node scripts/asset-integrity.mjs --write   # 에셋 해시 갱신 (필수)
npm test && npm run build:static
```

---

## 어디서 받나 (무료)

> 이 세션에서는 바깥 네트워크가 막혀 있어 아래 주소를 직접 열어 확인하지
> 못했다. 주소와 절차는 알고 있는 내용이고, **라이선스는 받기 전에 그 사이트에서
> 한 번 더 확인**하는 것이 좋다.

### 1. Mixamo — 제일 확실하다 (권장)

<https://www.mixamo.com>  · Adobe 계정으로 로그인하면 전부 무료

지금 들어 있는 동작 16개와 **같은 뼈대(mixamorig\*)** 라서 그대로 붙는다.
다른 사이트 모델은 뼈 이름이 달라 실패할 가능성이 크다.

받는 법: 위쪽 **Characters** 탭 → 아래 낱말로 검색 → 오른쪽 **Download** →
Format `FBX Binary(.fbx)` / Pose **T-pose**

| 역할 | Mixamo 에서 찾을 낱말 | 목록에 자주 보이는 이름 |
| --- | --- | --- |
| 대원 | `swat`, `police`, `soldier`, `vanguard` | Swat, Vanguard By T. Choonyung, Ch15 |
| 납치범 | `thug`, `criminal`, `bandit`, `mask`, `hoodie` | The Boss, Mutant 계열이 아닌 인간형, Ch09/Ch22 |
| 인질 | `business`, `casual`, `civilian`, `office` | Business Man, Claire, Sophie, Ch03/Ch06 |

> 목록은 수시로 바뀐다. 이름을 그대로 찾기보다 **검색해서 직접 보고 고르는 것**이
> 정확하다. 사람 형태(휴머노이드)이기만 하면 된다.

검색 주소를 바로 열고 싶다면 (로그인 후):

- 대원 <https://www.mixamo.com/#/?page=1&query=swat&type=Character>
- 납치범 <https://www.mixamo.com/#/?page=1&query=thug&type=Character>
- 인질 <https://www.mixamo.com/#/?page=1&query=business&type=Character>

### 2. CC0 — 출처 표기도 필요 없다

| 사이트 | 주소 | 비고 |
| --- | --- | --- |
| Quaternius | <https://quaternius.com/packs/ultimatemodularmencharacters.html> | CC0. 모듈형 인물 팩(양복·후드·군복) |
| Kenney | <https://kenney.nl/assets/mini-characters-1> | CC0. 각진 캐릭터. 분위기가 많이 달라진다 |
| KayKit (Kay Lousberg) | <https://kaylousberg.itch.io/kaykit-adventurers> | CC0 캐릭터 팩 |
| Poly Pizza | <https://poly.pizza/search/person> | 옛 Google Poly 보관소. CC0/CC-BY 혼재 |

이쪽 모델은 대부분 **Mixamo 뼈대가 아니다.** 그대로는 동작이 안 붙는다.
Mixamo 에 그 파일을 올려(**Upload Character**) 자동 리깅을 받은 뒤
`.fbx` 로 내려받아 쓰면 된다. 자동 리깅도 무료다.

### 3. Sketchfab — 골라 받기

- 납치범 <https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b&type=models&q=robber+mask>
- 인질 <https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b&type=models&q=civilian+man>
- 대원 <https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b&type=models&q=swat+officer>

위 주소의 `licenses=322a...` 는 **CC0** 필터다. CC-BY 도 쓸 수 있지만 출처 표기가
필요하다 (`public/credits.html` 에 적으면 된다). glTF(.glb) 로 받아서 Mixamo
자동 리깅을 거치는 것이 안전하다.

### 4. Ready Player Me — 아바타를 직접 만들기

<https://readyplayer.me>  — 무료로 만들어 `.glb` 로 받는다. 휴머노이드 뼈대라
Mixamo 자동 리깅과 궁합이 좋다. 인질/민간인용으로 쓰기 좋다.

---

## 지금 들어 있는 모델

`public/assets/models/character-animated.glb`

- 스킨: Mixamo 의 **Dreyar** (판타지 전사)
- 동작: 16개 (`idle aim crouchIdle crouchWalk crouchWalkAim run sprint strafeLeft
  strafeRight walkBack runBack fire reload jump hit death`)
- 크기: 1.8m 로 정규화, 텍스처 512px

역할별 파일을 하나도 넣지 않으면 대원·용의자·인질이 **같은 모델**을 쓰고
장구류(방탄조끼 / 어깨 표식 / 헬멧)로만 구분한다.

---

## 바꾸는 방법 (파일 하나만 주면 된다)

```sh
# 전부 바꾸기
node scripts/swap-character.mjs <새 캐릭터 파일>          # .fbx / .glb / .gltf
# 역할 하나만 바꾸기
node scripts/swap-character.mjs --role hostage <파일>
node scripts/swap-character.mjs --role suspect <파일>
node scripts/swap-character.mjs --role officer <파일>

node scripts/asset-integrity.mjs --write             # 에셋 해시 갱신 (필수)
npm test && npm run build:static
```

`swap-character.mjs` 가 하는 일:

1. 지금 GLB 에서 **동작 16개만** 꺼낸다.
2. 새 캐릭터를 불러와 키를 1.8m 로 맞추고, 텍스처를 512px JPEG 로 줄이고,
   중복 정점을 합친다.
3. 뼈 이름을 맞춘다. 같은 Mixamo 뼈라도 파일 형식에 따라 `mixamorig:Hips` /
   `mixamorigHips` / `mixamorig_Hips` 로 들어오므로, 이름을 단순화해 짝을 찾고
   클립의 트랙 이름을 새 뼈 이름으로 바꿔 준다.
4. 합쳐서 `character-animated.glb` 로 덮어쓴다.
5. `--role` 을 주면 `character-<역할>.glb` 로 저장하고
   `public/assets/models/roles.json` 의 `present` 목록에 등록한다. 게임은 이
   목록에 적힌 역할만 불러온다(없는 파일을 요청해 콘솔이 더러워지지 않게).

뼈 이름이 맞지 않으면 **덮어쓰지 않고** 어떤 뼈를 못 찾았는지 알려 주고 멈춘다.
그러니 잘못된 파일을 넣어도 지금 모델이 깨지지는 않는다.

역할별 모델을 되돌리려면 `roles.json` 의 `present` 에서 그 항목을 지우면 된다
(파일을 지워도 된다).

> 이 스크립트는 헤드리스 Chromium 을 쓴다(three.js 의 FBX 로더와 GLTF 내보내기가
> canvas 를 필요로 한다). 브라우저를 못 찾는다고 하면
> `CHROMIUM_PATH=/경로/chrome node scripts/swap-character.mjs ...` 로 지정한다.

### 조건

- **Mixamo 뼈대(`mixamorig*`)여야 한다.** 다른 뼈 이름을 쓰는 모델은 동작이
  안 붙는다.
- **T 포즈(동작 없는 스킨)로 받는다.** 동작이 들어 있어도 되지만 쓰이지 않는다.
- 장구류(조끼·헬멧·어깨 표식)는 `mixamorigSpine2`, `mixamorigHead`,
  `mixamorigLeftArm` / `mixamorigRightArm` 에 붙는다. 이 뼈들이 있어야 한다.
  (Mixamo 캐릭터는 전부 갖고 있다.)

---

## 받아서 저에게 주실 때

파일 하나(`.fbx` 권장, 또는 `.glb`)만 주시면 됩니다. 제가

1. `swap-character.mjs` 로 갈아 끼우고
2. 동작 16개가 전부 붙었는지 확인하고
3. 해시 갱신 · 테스트 · 정적 빌드까지 돌린 뒤
4. `public/credits.html` 에 출처를 적고 커밋합니다.

라이선스가 출처 표기를 요구하면 (CC-BY, Sketchfab 등) **저작자 이름과 원본 주소**를
같이 주세요. credits 에 정확히 적어야 합니다.

---

## 모델을 안 바꿔도 달라진 것

모델 자체를 바꾸지 않아도 사람이 구분되도록 장구류를 얹어 뒀다
(`public/js/entities.js` 의 `attachGear`).

| 대상 | 방탄조끼 | 어깨 표식 | 헬멧 |
| --- | --- | --- | --- |
| 대원 | 감청 | 팀 색 (파랑 계열) | 있음 |
| 용의자 | 어두운 올리브 | 주황 | 없음 |
| 주요 용의자 | 검정 | 빨강 | 있음 |
| 민간인 | 없음 | 하늘색 | 없음 |

어깨 표식은 스스로 빛나므로(emissive) 광원이 없는 복도에서도 보인다. 밤 작전에서
"저기 사람이 있는데 적인지 민간인인지 모르겠다" 를 없애기 위한 장치다.

# MARKET RAID 모델 복구 및 그래픽 개선

기준: `main`의 `387633b9c30c4b8cab4ab66b9fe55d633a1e70ea`.

## 확인한 원인

`config.js`는 모델 10개를 요청했지만 저장소의 `public/assets/models/`에는
`stall-wood.glb` 하나만 있었습니다. 나머지 9개는 로딩 실패 뒤 임시 도형으로
대체되었습니다. 원본 시장 에셋 폴더는 정적 빌드에서 제외되며, ZIP이나 원본
`scene.gltf`를 올리는 것만으로 개별 게임 객체와 연결되지 않습니다.

이번에 첨부된 SWAT의 필수 버퍼 이름은 `.bin`입니다. 뼈대 계층은 있으나
애니메이션 클립은 없습니다. 총 팩은 여러 무기가 한 장면에 들어 있고 일부
객체 이름이 실제 형상과 일치하지 않습니다.

## 모델 연결

| 게임 키 | 원본 팩 / 객체 | 파일 |
|---|---|---|
| character | psx swat guy rigged / 전체 뼈대 계층 | character.glb |
| rifle | Low Poly Gun Pack / M416_8 | weapon-rifle.glb |
| smg | Low Poly Gun Pack / UMP9_7 | weapon-smg.glb |
| sniper | Low Poly Gun Pack / AWM.001_6 | weapon-sniper.glb |
| stallTarp | Low Poly Market / Stall | stall-tarp.glb |
| crate | Low Poly Market / Create | crate.glb |
| barrel | Low Poly Market / Barrel | barrel.glb |
| vase | Low Poly Market / Vase | vase.glb |
| well | Low Poly Market / Well | well.glb |
| stallWood | 기존 저장소 모델 유지 | stall-wood.glb |

버퍼·텍스처를 GLB에 내장하고 객체별 정점과 재질만 패키징했습니다.
원본의 축 변환을 유지하면서 게임 좌표에서 정확한 정점 경계를 계산해 크기와
바닥 높이를 맞춥니다. 매대는 기존 충돌 영역에 맞추고 총구는 +X 기준으로
정렬합니다. 제작자/CC BY 4.0 크레딧은 게임 메뉴에서 열 수 있습니다.

재생성: 세 ZIP을 `swat/`, `guns/`, `market/`에 각각 압축 해제한 뒤
`npm run import:models -- /path/to/packs`를 실행합니다. SWAT의 `.bin`도 필요합니다.

## 시각 변경

- 타일 바닥, 오염·요철, 벽 재질, 환경광 반사
- 청록/주황 간판, 천장 조명과 보, 바닥 유도선, 먼지 입자
- 높은 품질에서 약한 블룸, 단일 스포트라이트 그림자
- 캐릭터의 절차적 다리 움직임과 무기 휴대 자세
- 탄착 입자와 별도 깊이 버퍼를 사용하는 1인칭 총
- 메뉴에서 품질/자동 조절 선택; 자동 저하를 영구 저장하지 않음

원본의 저폴리 스타일은 유지됩니다. 이 변경을 사실적인 고해상도 캐릭터나
모션캡처 애니메이션으로 오해하면 안 됩니다.

## 수정한 버그

- 캐릭터 삭제/재시작 시 공유 지오메트리와 텍스처 해제
- 사망 스냅샷의 빈 좌표로 인한 NaN 위치
- 뷰모델에서 공유 총 재질의 깊이 검사를 꺼 다른 총까지 영향을 주는 문제
- 터치 토글·조이스틱·발사 입력이 재시작이나 포커스 전환 뒤 남는 문제
- 조이스틱을 조금 움직여도 최고 속도가 되는 문제
- 재시작 시 ADS·반동·장전·해체 상태 잔류
- 총알 방향의 z=0이 -1로 바뀌는 문제와 점프 높이 누락
- 낮은 엄폐물, 바닥, 천장을 고려하지 않던 2D 총알 판정
- 드럼통 안에 겹친 폭발물 B
- 준비 전 시작, 경기 중 무기 변경으로 탄약 보충, 방 전환 시 이전 방 잔류
- 연결 실패/재접속 시 입력 리스너와 렌더러 잔류

## 검증 결과와 남은 확인

`npm test`: 10개 통과. 실제 GLB 전체를 Khronos glTF Validator로 검증하고
Three.js로 파싱하여 크기·중심·바닥 정렬을 확인했습니다. 두 Socket.IO
클라이언트로 준비/시작, 사격 방향, 점프 높이, 무기 변경 차단, 방 정리를
검증했습니다. 입력 초기화와 공유 리소스 수명도 테스트합니다.

`npm run build:static`: 통과. 필수 모델 누락/외부 의존성이 있으면 실패합니다.

**실제 GPU 화면과 모바일 FPS는 검증하지 못했습니다.** 검증용 브라우저가
로컬 게임 주소를 차단했습니다. 테스트의 텍스처 디코더는 대체 구현이므로
이미지 디코딩, 셰이더, 최종 색감 및 손/총의 시각 정렬까지 검증한 것은 아닙니다.
배포 미리보기에서 조명 밝기, 무기 3종의 조준, 캐릭터 자세, 모바일 터치를
확인한 뒤 반영해야 합니다. 아직 병합/프로덕션 배포하지 않았습니다.

로컬에서는 `npm start`로 웹/Socket.IO 서버를 함께 실행합니다. Vercel 정적
배포는 기존 구성대로 별도의 게임 서버와 `GAME_SERVER_URL`이 필요합니다.
이 작업 공간에는 배포 서버 환경 변수가 없으므로 실서비스 연결은 검증하지 않았습니다.

## 추가로 받을 무료 에셋

1. [Concrete Floor 02](https://polyhaven.com/a/concrete_floor_02): 바닥의 사실적인 질감.
   2K 해상도로 Diffuse/Base Color, Normal GL, Roughness, AO를 포함한 ZIP 권장.
2. [Brick Wall 10](https://polyhaven.com/a/brick_wall_10): 벽돌 벽의 질감과 요철.
   동일하게 2K PBR 맵 ZIP 권장.
3. [Mixamo](https://www.mixamo.com/): 캐릭터와 보행/소총 대기/달리기 동작.
   사용할 캐릭터를 선택해 FBX로, 첫 파일은 스킨 포함으로 받고 이후 동작도
   같은 캐릭터 기준으로 첨부하면 됩니다. 클립 이름은 검색 결과에서 확인하세요.

Poly Haven 에셋은 [CC0](https://polyhaven.com/license)입니다. Mixamo는 Adobe ID로
무료 사용 가능하며 게임에 캐릭터와 애니메이션을 사용할 수 있습니다
([Adobe FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)).

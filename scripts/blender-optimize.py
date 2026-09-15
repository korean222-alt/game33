# 헤드리스 블렌더로 GLB 의 내장 텍스처를 다시 인코딩한다. 형상은 건드리지 않는다.
#
#   python3 scripts/blender-optimize.py <입력.glb> <출력.glb> [--webp] [--draco]
#
# 기본값은 JPEG 다. glTF 표준 포맷이라 확장을 요구하지 않고, tests/assets.test.mjs
# 가 three 로 모델을 열어 중심·바닥·치수를 검사하는 경로가 그대로 살아 있다.
#
# --webp 는 20~40% 더 줄지만 EXT_texture_webp 를 extensionsRequired 에 넣는다.
#   브라우저는 전부 지원하나, three 의 그 확장은 self.URL 과 Blob 을 직접 써서
#   node 안에서는 파싱이 멎는다. 즉 위의 형상 검사를 잃는다.
# --draco 는 정점까지 압축해 더 줄지만, 정점이 확장 영역으로 들어가 같은 검사가
#   형상을 읽지 못한다. three 의 DRACOLoader 는 브라우저 Worker 를 쓰므로
#   node 에서 되살릴 수도 없다. 쓰려면 클라이언트에 DRACOLoader 를 붙이고
#   모델이 뜨거나 파묻히지 않는지 확인할 다른 수단을 먼저 마련해야 한다.
#
# JPEG 는 알파를 버린다. 그래서 재질이 하나라도 투명을 쓰면 원본 포맷을 유지한다.
import sys, os, json
import bpy          # bpy 를 먼저 들여와야 addon_utils 경로가 생긴다
import addon_utils

args = [a for a in sys.argv[1:] if not a.startswith('-')]
flags = {a for a in sys.argv[1:] if a.startswith('-')}
if len(args) != 2:
    raise SystemExit('사용법: python3 scripts/blender-optimize.py 입력.glb 출력.glb')
source, target = os.path.abspath(args[0]), os.path.abspath(args[1])

# 원본 glTF 를 먼저 읽어 투명을 쓰는 재질이 있는지 본다. 블렌더는 불러오는
# 과정에서 blend_method 를 제 나름대로 정하므로, 판단은 파일 쪽 alphaMode 로 한다.
with open(source, 'rb') as fh:
    raw = fh.read()
doc = json.loads(raw[20:20 + int.from_bytes(raw[12:16], 'little')])
transparent = [m.get('name', '?') for m in doc.get('materials', [])
               if m.get('alphaMode', 'OPAQUE') != 'OPAQUE']

addon_utils.enable('cycles', default_set=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=source)

tris = verts = 0
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles); verts += len(o.data.vertices)
print(f'들어온 것: 정점 {verts:,} / 삼각형 {tris:,} / '
      f'텍스처 {len([i for i in bpy.data.images if i.name != "Render Result"])}장 / '
      f'재질 {len(bpy.data.materials)}개')

if '--webp' in flags:
    image_format, quality = 'WEBP', 92
elif transparent:
    image_format, quality = 'AUTO', 90     # 원본 포맷 유지
    print(f'  투명을 쓰는 재질이 있어 텍스처 포맷을 유지한다: {", ".join(transparent)}')
else:
    image_format, quality = 'JPEG', 90

options = dict(
    filepath=target,
    export_format='GLB',
    export_apply=False,          # 모디파이어를 굽지 않는다. 형상 그대로.
    export_yup=True,             # glTF 규약. three.js 가 기대하는 축이다.
    export_animations=True,
    export_skins=True,
    export_morph=True,
    export_image_format=image_format,
    export_image_quality=quality,
)
if '--draco' in flags:
    options.update(
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=16,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=10,
        export_draco_generic_quantization=12,
    )

bpy.ops.export_scene.gltf(**options)

before, after = os.path.getsize(source), os.path.getsize(target)
print(f'{os.path.basename(source)}: {before:,} -> {after:,} 바이트 '
      f'({100 - after * 100 // before}% 감소, 텍스처 {image_format})')

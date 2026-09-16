# 헤드리스 블렌더로 사무실 소품 GLB 를 굽는다.
#
#   python3 scripts/blender-office-props.py [출력폴더]
#   (기본 출력: public/assets/models)
#
# 왜 손으로 안 만들고 스크립트로 만드는가
#   받아 온 모형은 크기도 원점도 제각각이라 맵 좌표에 놓을 때마다 fit 값을 새로
#   재야 한다. 여기서 만드는 것들은 전부 "밑면이 y=0, 중심이 x=z=0" 규약을
#   지키고, 아래 SIZES 에 적힌 치수가 곧 config.js 의 fit.size 다. 모형을 고치면
#   치수도 같이 바뀌므로 어긋날 수가 없다.
#
# 왜 텍스처가 없는가
#   전부 재질 색 + 거칠기/금속성만 쓴다. 텍스처 한 장이 소품 여덟 개의 형상
#   전체보다 무겁고, 이 게임은 밤이라 표면 무늬보다 형태와 반사가 훨씬 크게
#   보인다. 덕분에 여덟 개를 합쳐도 수십 KB 다.
#
# 베벨을 왜 거는가
#   각진 상자는 어떤 조명에서도 상자로 보인다. 모서리를 2~4mm 만 깎아 주면
#   그 면이 빛을 받아 윤곽선이 생기고, 그때부터 "실제 물건" 으로 보인다.
#   비용은 면 몇 개뿐이다.
import sys
import os
import math
import bpy
from mathutils import Vector

OUT_DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'public/assets/models')
os.makedirs(OUT_DIR, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_materials = {}


def mat(name, color, roughness=0.6, metallic=0.0, emission=None, alpha=1.0):
    key = (name, color, roughness, metallic, emission, alpha)
    if key in _materials and _materials[key].name in bpy.data.materials:
        return _materials[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 1.0
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    _materials[key] = m
    return m


def box(name, size, loc, material, bevel=0.004, rot=None):
    """중심이 loc 인 상자. size/loc 은 블렌더 좌표(z 가 위) 그대로 쓴다.

    ⚠ 원점에서 만들고 크기를 확정한 뒤에 옮긴다. transform_apply 는 scale 만
    켜도 위치까지 정점에 구워 넣어서, loc 을 준 채로 부르면 그 뒤에 location 을
    다시 대입할 때 이동이 두 번 먹는다. (화분 잎이 2m 밖으로 날아가 있던
    것이 그것이었다 - 잎마다 조금씩 더 밀려 나가고 있었다.)"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if rot:
        o.rotation_euler = rot
    o.location = loc
    o.data.materials.append(material)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = 2
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(40)
    return o


def cyl(name, r, h, loc, material, verts=16, bevel=0.003, rot=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=(0, 0, 0), vertices=verts)
    o = bpy.context.object
    o.name = name
    if rot:
        o.rotation_euler = rot
    o.location = loc
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    for p in o.data.polygons:
        p.use_smooth = abs(p.normal.z) < 0.5
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = 1
    return o


def finish(name, target_size=None):
    """모든 메시를 하나로 합치고, 밑면을 z=0 · 중심을 원점으로 맞춘 뒤 내보낸다."""
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.convert(target='MESH')          # 모디파이어(베벨)를 확정한다
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name

    # 경계 상자를 재서 원점을 바닥 한가운데로 옮긴다. 맵 코드가 이 규약을
    # 가정하고 좌표를 주므로, 여기가 틀어지면 소품이 바닥에 파묻히거나 뜬다.
    #
    # bound_box 가 아니라 정점을 직접 잰다. join 직후의 bound_box 는 아직
    # 갱신되기 전 값이 나올 수 있는데, 그 값으로 원점을 옮기면 소품이 통째로
    # 어긋난다 (화분이 3m 짜리로 나오던 것이 그것이었다).
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    mid = (lo + hi) / 2
    for v in o.data.vertices:
        w = o.matrix_world @ v.co
        v.co = Vector((w.x - mid.x, w.y - mid.y, w.z - lo.z))
    o.matrix_world.identity()
    o.data.update()

    size = hi - lo
    path = os.path.join(OUT_DIR, f'{name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB',
        use_selection=False, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True,
        export_materials='EXPORT',
    )
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    kb = os.path.getsize(path) / 1024
    # glTF 는 Y-up 이므로 블렌더의 (x, y, z) 가 (x, z, y) 로 나간다.
    print(f'  {name:12s} {size.x:.3f} x {size.z:.3f} x {size.y:.3f} m   '
          f'{tris:5d} tri   {kb:6.1f} KB')
    return (round(size.x, 3), round(size.z, 3), round(size.y, 3))


# --------------------------------------------------------------------------- #
#  소품들
# --------------------------------------------------------------------------- #
def build_monitor():
    """24인치 모니터. 책상 예순 개 위에 얹힌다 - 이 게임에서 제일 많이 그려지는 소품."""
    stand_m = mat('mon_stand', (0.09, 0.10, 0.11), 0.42, 0.65)
    bezel_m = mat('mon_bezel', (0.05, 0.05, 0.06), 0.35)
    # 꺼진 화면이 아니라 켜진 화면. 밤의 사무실에서 이 빛이 방을 규정한다.
    screen_m = mat('mon_screen', (0.10, 0.16, 0.22), 0.18, 0.0,
                   emission=(0.16, 0.28, 0.42))
    box('base', (0.22, 0.14, 0.016), (0, 0, 0.008), stand_m)
    box('neck', (0.045, 0.035, 0.17), (0, 0, 0.095), stand_m)
    box('panel', (0.545, 0.028, 0.335), (0, 0.012, 0.29), bezel_m, rot=(math.radians(-5), 0, 0))
    box('screen', (0.515, 0.006, 0.305), (0, -0.006, 0.292), screen_m, bevel=0,
        rot=(math.radians(-5), 0, 0))
    return finish('monitor')


def build_office_chair():
    """바퀴 다섯 개짜리 사무 의자."""
    frame = mat('chair_frame', (0.10, 0.11, 0.12), 0.38, 0.7)
    fabric = mat('chair_fabric', (0.16, 0.20, 0.25), 0.95)
    for i in range(5):
        a = i * math.tau / 5
        box(f'leg{i}', (0.30, 0.045, 0.028),
            (math.cos(a) * 0.15, math.sin(a) * 0.15, 0.058), frame, rot=(0, 0, a))
        cyl(f'wheel{i}', 0.028, 0.020, (math.cos(a) * 0.28, math.sin(a) * 0.28, 0.028), frame, verts=10)
    cyl('post', 0.032, 0.20, (0, 0, 0.16), frame, verts=12)
    box('seat', (0.46, 0.44, 0.075), (0, 0, 0.30), fabric, bevel=0.012)
    box('back', (0.44, 0.07, 0.46), (0, 0.19, 0.56), fabric, bevel=0.012,
        rot=(math.radians(9), 0, 0))
    for s in (-1, 1):
        box(f'arm{s}', (0.05, 0.30, 0.028), (s * 0.245, -0.01, 0.42), frame)
        box(f'armpost{s}', (0.035, 0.035, 0.10), (s * 0.245, 0.06, 0.37), frame)
    return finish('officeChair')


def build_server_rack():
    """42U 랙. 앞면은 검은 격자, 위쪽에 상태 표시등이 줄지어 켜져 있다."""
    shell = mat('rack_shell', (0.07, 0.075, 0.08), 0.45, 0.6)
    vent = mat('rack_vent', (0.03, 0.033, 0.036), 0.7)
    led_g = mat('rack_led_g', (0.1, 0.5, 0.2), 0.3, 0.0, emission=(0.10, 0.75, 0.25))
    led_a = mat('rack_led_a', (0.6, 0.35, 0.05), 0.3, 0.0, emission=(0.95, 0.52, 0.06))
    box('side_l', (0.035, 0.98, 2.00), (-0.30, 0, 1.00), shell)
    box('side_r', (0.035, 0.98, 2.00), (0.30, 0, 1.00), shell)
    box('top', (0.63, 0.98, 0.04), (0, 0, 1.98), shell)
    box('foot', (0.63, 0.98, 0.06), (0, 0, 0.03), shell)
    box('back', (0.60, 0.03, 1.92), (0, 0.48, 1.02), shell)
    # 서버 한 대가 1U. 사이에 틈을 남겨 장비가 꽂혀 있는 것으로 보이게 한다.
    for i in range(14):
        z = 0.14 + i * 0.128
        box(f'u{i}', (0.565, 0.90, 0.098), (0, -0.02, z), vent, bevel=0.003)
        if i % 3 != 2:
            box(f'led{i}', (0.020, 0.012, 0.012), (-0.24, -0.47, z + 0.03),
                led_g if i % 4 else led_a, bevel=0)
    return finish('serverRack')


def build_copier():
    """복합기. 급지 트레이가 튀어나와 있고 조작 패널이 켜져 있다."""
    body = mat('copier_body', (0.78, 0.79, 0.80), 0.52)
    dark = mat('copier_dark', (0.14, 0.15, 0.16), 0.5)
    glass = mat('copier_glass', (0.18, 0.22, 0.26), 0.15)
    panel = mat('copier_panel', (0.12, 0.30, 0.36), 0.25, 0.0, emission=(0.10, 0.42, 0.50))
    box('base', (0.68, 0.62, 0.62), (0, 0, 0.31), body, bevel=0.008)
    box('mid', (0.70, 0.64, 0.30), (0, 0, 0.77), dark, bevel=0.006)
    box('top', (0.70, 0.64, 0.14), (0, 0, 0.99), body, bevel=0.006)
    box('lid', (0.66, 0.60, 0.05), (0, 0, 1.08), glass, bevel=0.004)
    box('tray1', (0.60, 0.10, 0.06), (0, -0.36, 0.52), dark)
    box('tray2', (0.52, 0.16, 0.035), (0, -0.40, 0.70), body)
    box('panel', (0.26, 0.10, 0.035), (0.19, -0.33, 0.95), panel, bevel=0.003)
    for i in range(3):
        box(f'drawer{i}', (0.64, 0.02, 0.012), (0, -0.315, 0.12 + i * 0.16), dark, bevel=0)
    return finish('copier')


def build_water_cooler():
    """정수기. 위에 물통이 얹혀 있다."""
    body = mat('cool_body', (0.86, 0.87, 0.88), 0.48)
    dark = mat('cool_dark', (0.13, 0.14, 0.15), 0.5)
    water = mat('cool_water', (0.45, 0.68, 0.78), 0.12, 0.0, alpha=0.55)
    box('body', (0.34, 0.34, 0.92), (0, 0, 0.46), body, bevel=0.01)
    box('back', (0.30, 0.05, 0.28), (0, 0.16, 1.05), body)
    cyl('bottle', 0.14, 0.42, (0, 0, 1.13), water, verts=18)
    cyl('neck', 0.055, 0.08, (0, 0, 0.94), water, verts=12)
    box('tap_blue', (0.05, 0.08, 0.05), (-0.07, -0.18, 0.66), dark)
    box('tap_red', (0.05, 0.08, 0.05), (0.07, -0.18, 0.66), dark)
    box('tray', (0.22, 0.10, 0.02), (0, -0.16, 0.52), dark)
    return finish('waterCooler')


def build_vending():
    """자판기. 앞면이 통유리라 안에 든 캔이 보이고, 그 빛이 복도로 샌다."""
    shell = mat('vend_shell', (0.16, 0.18, 0.22), 0.5)
    glass = mat('vend_glass', (0.55, 0.68, 0.75), 0.1, 0.0, alpha=0.4)
    lit = mat('vend_lit', (0.85, 0.88, 0.80), 0.3, 0.0, emission=(0.95, 0.92, 0.72))
    cans = [mat(f'can{i}', c, 0.35, 0.5) for i, c in enumerate(
        [(0.62, 0.12, 0.12), (0.12, 0.34, 0.60), (0.15, 0.48, 0.24), (0.72, 0.58, 0.10)])]
    box('shell', (0.92, 0.78, 1.90), (0, 0.02, 0.95), shell, bevel=0.01)
    box('window', (0.74, 0.03, 1.36), (-0.05, -0.37, 1.10), glass, bevel=0)
    box('header', (0.92, 0.06, 0.20), (0, -0.37, 1.80), lit, bevel=0.004)
    for row in range(5):
        for col in range(6):
            cyl(f'can{row}_{col}', 0.033, 0.11,
                (-0.36 + col * 0.125, -0.22, 0.56 + row * 0.25),
                cans[(row + col) % 4], verts=8, bevel=0)
        box(f'shelf{row}', (0.72, 0.30, 0.012), (-0.05, -0.22, 0.49 + row * 0.25), shell, bevel=0)
    box('slot', (0.34, 0.06, 0.12), (0.28, -0.37, 0.36), shell)
    box('keypad', (0.14, 0.03, 0.30), (0.34, -0.38, 1.10), lit, bevel=0.003)
    return finish('vending')


def build_plant_tall():
    """화분에 심은 관엽수. 잎이 여러 방향으로 뻗어야 실루엣이 산다."""
    pot = mat('plant_pot', (0.24, 0.20, 0.17), 0.8)
    soil = mat('plant_soil', (0.10, 0.08, 0.06), 0.95)
    stem = mat('plant_stem', (0.16, 0.24, 0.13), 0.9)
    leaf = mat('plant_leaf', (0.13, 0.32, 0.16), 0.85)
    cyl('pot', 0.23, 0.42, (0, 0, 0.21), pot, verts=14)
    cyl('rim', 0.25, 0.05, (0, 0, 0.42), pot, verts=14)
    cyl('soil', 0.21, 0.03, (0, 0, 0.43), soil, verts=14)
    cyl('trunk', 0.035, 0.55, (0, 0, 0.70), stem, verts=8)
    # 잎은 얇고 넓은 상자를 기울여 세운다. 열두 장이면 어느 각도에서 봐도
    # 실루엣이 잎으로 읽힌다.
    for i in range(12):
        a = i * math.tau / 12 + (i % 3) * 0.2
        tilt = math.radians(42 + (i % 4) * 11)
        h = 0.92 + (i % 3) * 0.13
        box(f'leaf{i}', (0.16, 0.44, 0.012),
            (math.cos(a) * 0.17, math.sin(a) * 0.17, h), leaf, bevel=0.002, rot=(tilt, 0, a))
    return finish('plantTall')


def build_conf_table():
    """회의 탁자. 상판 가운데에 배선 트레이가 나 있다."""
    top_m = mat('conf_top', (0.34, 0.26, 0.19), 0.35)
    leg_m = mat('conf_leg', (0.10, 0.11, 0.12), 0.35, 0.7)
    dark = mat('conf_dark', (0.07, 0.07, 0.08), 0.6)
    box('top', (3.60, 1.40, 0.045), (0, 0, 0.725), top_m, bevel=0.006)
    box('rail', (3.20, 0.20, 0.06), (0, 0, 0.66), dark)
    for s in (-1, 1):
        box(f'leg{s}', (0.10, 1.10, 0.66), (s * 1.48, 0, 0.33), leg_m, bevel=0.006)
        box(f'foot{s}', (0.16, 1.24, 0.04), (s * 1.48, 0, 0.02), leg_m)
    box('tray', (0.70, 0.22, 0.02), (0, 0, 0.756), dark, bevel=0.003)
    for i in (-1, 1):
        box(f'port{i}', (0.10, 0.10, 0.022), (i * 0.2, 0, 0.768), leg_m, bevel=0.002)
    return finish('confTable')


BUILDERS = [
    ('monitor', build_monitor),
    ('officeChair', build_office_chair),
    ('serverRack', build_server_rack),
    ('copier', build_copier),
    ('waterCooler', build_water_cooler),
    ('vending', build_vending),
    ('plantTall', build_plant_tall),
    ('confTable', build_conf_table),
]

if __name__ == '__main__':
    print(f'사무실 소품을 굽는다 -> {OUT_DIR}')
    sizes = {}
    for name, fn in BUILDERS:
        reset()
        _materials.clear()
        sizes[name] = fn()
    total = sum(os.path.getsize(os.path.join(OUT_DIR, f'{n}.glb')) for n, _ in BUILDERS)
    print(f'\n  합계 {total / 1024:.1f} KB')
    print('\nconfig.js 의 fit.size 에 그대로 넣을 값:')
    for name, size in sizes.items():
        print(f'  {name}: [{size[0]}, {size[1]}, {size[2]}],')

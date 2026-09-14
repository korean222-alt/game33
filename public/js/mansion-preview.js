import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AssetManager } from './assets.js';
import { World } from './world.js';
import { VisualPipeline } from './visuals.js';
const status=document.querySelector('#status');
try {
  const renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  document.body.prepend(renderer.domElement);
  const assets=new AssetManager(renderer);
  await assets.loadAll();
  const world=new World(renderer,assets).build('high');
  const camera=new THREE.PerspectiveCamera(65,innerWidth/innerHeight,.05,100);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.minDistance=.4;controls.maxDistance=18;
  controls.maxPolarAngle=Math.PI*.75;
  const views={
    entry:[[0,1.75,16],[0,2,-6]],
    hall:[[-7,2.6,11],[1,2,-5]],
    stairs:[[0,4.1,-14],[0,2,9]],
    library:[[-11,2,-8],[-20,2,-15]],
    dining:[[-11,2,8],[-18,1.5,13]],
    gallery:[[11,2,-4],[20,2,3]],
  };
  const view=key=>{camera.position.set(...views[key][0]);controls.target.set(...views[key][1]);controls.update();};
  view('entry');
  document.querySelectorAll('[data-room]').forEach(button=>button.onclick=()=>{
    view(button.dataset.room);
    document.querySelectorAll('[data-room]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  });
  THREE.DefaultLoadingManager.onLoad=()=>{status.textContent=assets.missing.length?'일부 모델을 불러오지 못했습니다. 새로고침해 주세요.':'48 × 36m · 7개 구역 · 첨부한 바닥·벽 재질 적용';};
  THREE.DefaultLoadingManager.onError=url=>{status.textContent='재질 로딩 실패: '+url;};
  const pipeline=new VisualPipeline(renderer,world.scene,camera,'high'),clock=new THREE.Clock();
  renderer.setAnimationLoop(()=>{const dt=Math.min(clock.getDelta(),.1);world.update(dt);controls.update();pipeline.render();});
  addEventListener('resize',()=>{
    renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();pipeline.resize();
  });
}catch(error){status.textContent='3D 화면을 열지 못했습니다: '+error.message;console.error(error);}

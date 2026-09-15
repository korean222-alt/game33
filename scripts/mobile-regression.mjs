import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'3193'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);server.stdout.on('data',data=>{if(String(data).includes('서버 준비됨')){clearTimeout(timer);resolve();}});server.on('error',reject);});
const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
await fs.mkdir('test-artifacts',{recursive:true});
try {
  for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{})});
    try {
      const page=await browser.newPage({viewport:{width:414,height:736},isMobile:true,hasTouch:true});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('http://localhost:3193/',route=>route.fulfill({contentType:'text/html',body:html.replace('<script type="module" src="/js/main.js"></script>',`<script type="module">
        import { Hud } from '/js/hud.js'; import { installViewport } from '/js/viewport.js';
        installViewport(); window.hud=new Hud(); hud.show(null); hud.showTouch(true);
        hud.setDoor({state:'locked'},'문틈 확인 · 잠금 해제 · 강제 개방',{primary:'unlock',peek:true,kick:true});
        hud.setDefuse(true,'예비 발전기 차단기 올리기',.5); hud.setBlackout(true);
        hud.subtitle('무기를 버리고 손을 보여라.','ME',60000);
        hud.radio('지휘부: 북동쪽 작업실의 예비 발전기를 찾아 차단기를 올려라.');
        window.fixtureReady=true;
      </script>`)}));
      await page.goto('http://localhost:3193/');await page.waitForFunction(()=>window.fixtureReady);
      for(const height of [736,640,812]) {
        await page.setViewportSize({width:414,height});
        await page.waitForFunction(h=>Math.abs(document.querySelector('#hud').getBoundingClientRect().height-h)<2,height);
        const rects=await page.evaluate(()=>{
          const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
          return {subtitle:rect('subtitle'),door:rect('door'),controls:rect('ctlBar'),stack:rect('bottomStack'),radio:getComputedStyle(document.getElementById('radio')).display};
        });
        assert.equal(rects.radio,'none');
        assert.ok(rects.subtitle.top>=46,`${name}/${height}: subtitle overlaps top HUD: ${JSON.stringify(rects)}`);
        assert.ok(rects.subtitle.bottom<=rects.door.top,`${name}: subtitle overlaps door`);
        assert.ok(rects.door.bottom<rects.controls.top,`${name}: door overlaps controls`);
        await page.screenshot({path:`test-artifacts/${name}-414x${height}.png`});
      }
      await page.evaluate(()=>{hud.setDoor(null);hud.setDefuse(false);});
      assert.equal(await page.locator('#radio').isVisible(),true);
      await page.evaluate(()=>hud.setDoor({state:'closed'},'문 안내',{primary:'open'}));
      assert.equal(await page.locator('#radio').isVisible(),false);
      await page.evaluate(()=>hud.setDoor(null));
      assert.equal(await page.locator('#radio').isVisible(),true);
      await page.evaluate(()=>hud.resetForNewMatch());
      assert.equal(await page.locator('#radio').isVisible(),false);
      assert.deepEqual(errors,[]);
      console.log(`${name}: 414px HUD, viewport resize, radio pause/resume/reset passed`);
    } finally {await browser.close();}
  }
} finally {server.kill();}

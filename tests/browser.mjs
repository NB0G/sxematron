/** Real-browser smoke. Run npm run build; npx playwright install chromium; npm run test:browser. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { buildServer } from '../dist/apps/server/src/server.js';
const root=path.resolve(import.meta.dirname,'..');
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gost-browser-'));
const output=path.join(root,'artifacts','browser');
await fs.mkdir(output,{recursive:true});
const report={checks:[],pageErrors:[],externalRequests:[],consoleErrors:[]};
const app=await buildServer({dataDir:path.join(tmp,'data'),projectDir:root});
let browser;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS',name);}
try{
 await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();const base=`http://127.0.0.1:${address.port}`;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:process.env.CHROMIUM_ARGS_JSON?JSON.parse(process.env.CHROMIUM_ARGS_JSON):['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(15000);
 page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text())});page.on('request',r=>{if(!r.url().startsWith(base)&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))report.externalRequests.push(r.url())});page.on('dialog',d=>d.accept());
 async function capture(name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});}
 async function downloadJson(){const waiting=page.waitForEvent('download');await page.getByRole('button',{name:/^↓ JSON/}).click();const dl=await waiting;return JSON.parse(await fs.readFile(await dl.path(),'utf8'));}
 async function openExample(name){await page.locator('input[type=file]').first().setInputFiles(path.join(root,'examples',name));await page.locator('[data-section-key="amp/A"]').waitFor();}
 await check('production server + CSP + library + JSON import',async()=>{await page.goto(base);await page.getByText('9 УГО',{exact:true}).waitFor();await openExample('demo.json');assert.equal(await page.locator('[data-section-key]').count(),4);assert.equal(await page.getByText('0 ошибок · 0 предупреждений',{exact:false}).count(),1);await capture('browser-schematic');});
 await check('multisheet navigation and portable outlined SVG ZIP download',async()=>{await page.getByRole('button',{name:/Лист 2/}).click();await page.locator('[data-section-key="amp/POWER"]').waitFor();assert.equal(await page.locator('[data-section-key]').count(),1);await capture('browser-sheet-2');const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'↓ ZIP листов'}).click();const file=await waiting;const zip=unzipSync(await fs.readFile(await file.path()));assert.equal(Object.keys(zip).length,2);assert.match(strFromU8(zip['sheet_02.svg']),/width="420mm"/);assert.doesNotMatch(strFromU8(zip['sheet_02.svg']),/<text\b/);});
 await check('section follows the mouse; wiring appears only after server response; undo restores position',async()=>{
  await page.getByRole('button',{name:/Лист 1/}).click();
  const section=page.locator('[data-section-key="r_input/BODY"]');
  const originalTransform=await section.getAttribute('transform');
  const sheet=await page.locator('.sheet-wrap').boundingBox();
  const from={x:sheet.x+65/420*sheet.width,y:sheet.y+67.5/297*sheet.height};
  const endpoint='**/api/schematics/build';
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route(endpoint,async route=>{await gate;await route.continue();});
  try{
   await page.mouse.move(from.x,from.y);await page.mouse.down();
   await page.mouse.move(from.x+20/420*sheet.width,from.y+10/297*sheet.height,{steps:8});
   assert.notEqual(await section.getAttribute('transform'),originalTransform);
   assert.equal(await page.locator('.schematic-wiring').first().evaluate(el=>getComputedStyle(el).visibility),'hidden');
   const submitted=page.waitForRequest(r=>r.url().endsWith('/api/schematics/build')&&r.method()==='POST');
   await page.mouse.up();
   await submitted;
   assert.notEqual(await section.getAttribute('transform'),originalTransform);
   assert.equal(await page.locator('.schematic-wiring').first().evaluate(el=>getComputedStyle(el).visibility),'hidden');
  }finally{release();await page.unrouteAll({behavior:'wait'});}
  await page.locator('.sheet-svg:not(.wires-pending) .schematic-wiring').first().waitFor({state:'visible'});
  const json=await downloadJson();
  assert.deepEqual(json.components.find(c=>c.id==='r_input').sections.BODY.position,{x:80,y:75});
  assert.equal(json.components.find(c=>c.id==='r_input').sections.BODY.locked,true);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>document.querySelector('[data-section-key="r_input/BODY"]')?.getAttribute('transform')==='translate(60 65) rotate(0) scale(1 1)');
  const undone=await downloadJson();assert.deepEqual(undone.components.find(c=>c.id==='r_input').sections.BODY.position,{x:60,y:65});
 });
 await check('manual wire geometry survives orthogonal edit and JSON round trip',async()=>{const box=await page.locator('.sheet-wrap').boundingBox();await page.mouse.click(box.x+300/420*box.width,box.y+180/297*box.height);await page.getByLabel('Маршруты листа').click();await page.getByRole('option',{name:/^SIGNAL/}).click();const y=page.getByLabel('Y, мм',{exact:true});const original=Number(await y.inputValue());await y.fill(String(original+5));await y.blur();await page.waitForTimeout(100);const json=await downloadJson();const manual=json.layout.routes.filter(r=>r.locked);assert.ok(manual.length);for(const r of manual)for(let i=1;i<r.points.length;i++)assert.ok(r.points[i].x===r.points[i-1].x||r.points[i].y===r.points[i-1].y);await page.locator('input[type=file]').first().setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(json))});await page.locator('[data-section-key="amp/A"]').waitFor();const roundtrip=await downloadJson();assert.deepEqual(roundtrip.layout.routes.filter(r=>r.locked),manual);});
 await check('a wire segment slides; double-click adds/removes points and a bend can be dragged directly',async()=>{
  const id='editable_wire';
  const pins=[{instance_id:'left',number:'2'},{instance_id:'right',number:'1'}];
  const initial=[{x:75,y:82.5},{x:100,y:82.5},{x:100,y:115},{x:150,y:115},{x:150,y:82.5},{x:175,y:82.5}];
  const schematic={format_version:'1.0',document:{title:'Проверка жестов',designation:'WIRE'},sheets:[{id:'sheet_1'}],groups:[],
   components:[['left',60],['right',180]].map(([id,x])=>({id,component_code:'GEN_R',variant_code:'01',sections:{BODY:{sheet_id:'sheet_1',position:{x,y:80},locked:true}}})),
   nets:[{id:'net',render:'wire',pins}],layout:{mode:'mixed',unit:'mm',routes:[{id,net_id:'net',sheet_id:'sheet_1',locked:true,points:initial}]}};
  const supply=page.locator(`.sheet-svg polyline[data-route-id="${id}"]`).last();
  await page.locator('input[type=file]').first().setInputFiles({name:'gestures.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(schematic))});
  await supply.waitFor();
  const b=await page.locator('.sheet-wrap').boundingBox(),xy=(x,y)=>[b.x+x/420*b.width,b.y+y/297*b.height];
  const waitPoints=(points)=>page.waitForFunction(({id,points})=>{
   const route=document.querySelector(`.sheet-svg polyline[data-route-id="${id}"]`);
   return route?.getAttribute('points')===points&&!document.querySelector('[data-wire-preview]');
  },{id,points:points.map(p=>p.x+','+p.y).join(' ')});
  await page.mouse.move(...xy(127.5,115));await page.mouse.down();await page.mouse.move(...xy(127.5,125),{steps:5});
  await page.locator('[data-wire-preview]').waitFor();
  await page.mouse.up();
  const shifted=initial.map((p,i)=>i===2||i===3?{...p,y:125}:p);
  await waitPoints(shifted);
  await page.mouse.dblclick(...xy(127.5,125));
  await waitPoints([...shifted.slice(0,3),{x:127.5,y:125},...shifted.slice(3)]);
  await page.mouse.dblclick(...xy(127.5,125));
  await waitPoints(shifted);
  await page.mouse.move(...xy(100,125));await page.mouse.down();await page.mouse.move(...xy(105,130),{steps:5});await page.mouse.up();
  const moved=[shifted[0],{x:105,y:82.5},{x:105,y:130},{x:150,y:130},...shifted.slice(4)];
  await waitPoints(moved);
  await page.mouse.dblclick(...xy(105,130));
  await waitPoints([...moved.slice(0,2),...moved.slice(4)]);
  const json=await downloadJson();
  assert.equal(json.layout.routes[0].locked,true);
  assert.deepEqual(json.nets[0].pins,pins);
  await openExample('demo.json');
 });
 await check('invalid pin import is rejected without replacing current document',async()=>{await page.locator('input[type=file]').first().setInputFiles(path.join(root,'examples','invalid_pin.json'));await page.getByText(/нет физического вывода 999/).waitFor();assert.equal(await page.locator('[data-section-key]').count(),4);await openExample('demo.json');});
 await check('library component can be added manually to an existing scheme',async()=>{await page.getByRole('button',{name:'+ Компонент',exact:true}).click();await page.getByLabel('Библиотечное определение').click();await page.getByRole('option',{name:/Резистор/}).click();await page.getByLabel('Номинал / значение',{exact:true}).fill('47 кОм');await page.getByRole('button',{name:'Добавить',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('4 компонентов'));const json=await downloadJson();assert.equal(json.components.length,4);assert.ok(json.components.some(c=>c.value==='47 кОм'));});
 await check('manual electrical net editor uses physical pin numbers',async()=>{await page.getByRole('button',{name:'+ Электрическая цепь',exact:true}).click();await page.getByLabel('Имя цепи / метки').fill('MANUAL');await page.getByLabel('Отображение',{exact:true}).click();await page.getByRole('option',{name:'Именованные метки'}).click();const dialog=page.getByRole('dialog');await dialog.locator('input[type=checkbox]:not(:disabled)').first().check();await page.getByRole('button',{name:'Применить',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('9 цепей'));const json=await downloadJson();assert.ok(json.nets.some(n=>n.name==='MANUAL'&&n.pins.length===1));});
 await check('constructor JSON import + graphical circle + library persistence',async()=>{await page.getByRole('button',{name:/Конструктор$/}).click();const def=JSON.parse(await fs.readFile(path.join(root,'examples/component_resistor.json'),'utf8'));def.component_code='BROWSER_TEST';def.name='Браузерный тестовый компонент';await page.locator('input[type=file]').last().setInputFiles({name:'browser-component.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(def))});await page.getByLabel('Постоянный код',{exact:true}).waitFor();await page.getByRole('button',{name:'Окружность',exact:true}).click();const canvas=page.locator('svg').filter({has:page.locator('#component-grid')});const box=await canvas.boundingBox();const x=box.x+(50+30)/140*box.width,y=box.y+(25+30)/100*box.height;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+8/140*box.width,y,{steps:5});await page.mouse.up();const waiting=page.waitForResponse(r=>r.url()===base+'/api/components'&&r.request().method()==='POST');await page.getByRole('button',{name:/Сохранить в библиотеку/}).click();assert.equal((await waiting).status(),201);const saved=await(await page.request.get(base+'/api/components/BROWSER_TEST')).json();assert.ok(saved.variants[0].sections[0].graphics.some(p=>p.kind==='circle'));assert.deepEqual(saved.physical_pins,[{number:'1'},{number:'2'}]);await capture('browser-constructor');});
 await check('library search/preview and generated current catalog',async()=>{await page.getByRole('button',{name:/Библиотека$/}).click();await page.getByPlaceholder('Название, код или категория').fill('BROWSER_TEST');await page.getByText('Браузерный тестовый компонент',{exact:true}).waitFor();await capture('browser-library');await page.getByRole('button',{name:/Документы$/}).click();await page.getByRole('button',{name:'COMPONENT_CATALOG.md',exact:true}).click();await page.locator('.doc-content').filter({hasText:'BROWSER_TEST'}).waitFor();await capture('browser-documentation');});
 await check('theme toggle and mobile viewing without page overflow',async()=>{await page.getByRole('button',{name:/Тёмная$/}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('theme')),'dark');await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);assert.equal(overflow,false);});
 await check('importing example 00 uses server SVG and reports no warnings',async()=>{
  await page.getByRole('button',{name:/Схемы$/}).click();
  const waiting=page.waitForResponse(r=>r.url().endsWith('/api/schematics/build')&&r.request().method()==='POST');
  await page.locator('input[type=file]').first().setInputFiles(path.join(root,'examples','00_smoke_import.json'));
  assert.equal((await waiting).status(),200);
  await page.locator('[data-section-key="x1/BODY"]').waitFor();
  assert.equal(await page.locator('[data-section-key]').count(),12);
  assert.equal(await page.getByText('0 ошибок · 0 предупреждений',{exact:false}).count(),1);
 });
 await check('offline runtime makes no external requests and has no JavaScript/CSP errors',async()=>{assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);});
 report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;throw e;}
finally{await fs.writeFile(path.join(output,'browser-tests.json'),JSON.stringify(report,null,2));if(browser)await browser.close();await app.close();await fs.rm(tmp,{recursive:true,force:true});}

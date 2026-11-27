import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildServer } from '../apps/server/src/server.js';
import { routingBatches, SchematicBuildPool } from '../apps/server/src/schematic-build.js';
import type { ComponentDefinition, Resolved, Schematic } from '../packages/core/src/types.js';

const definition = (code='TEST_R'): ComponentDefinition => ({
  format_version:'1.0',component_code:code,name:'Тестовый резистор',category:'passive',positional_prefix:'R',physical_pins:[{number:'1'},{number:'2'}],
  variants:[{variant_code:'01',name:'Основной',sections:[{section_id:'BODY',graphics:[{id:'rect',kind:'rectangle',x:0,y:0,width:10,height:5}],pins:[{number:'1',x:-5,y:2.5,side:'left'},{number:'2',x:15,y:2.5,side:'right'}]}]}]
});

async function fixture(t: TestContext,build?:{buildWorkers:number;buildQueue:number}) {
  const dataDir = mkdtempSync(path.join(tmpdir(),'gost-server-'));
  const app = await buildServer({dataDir,seed:false,...build});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  return {app,dataDir};
}

function buildPayload(title='Пример') {
  const schematic: Schematic = {
    format_version:'1.0',document:{title,designation:'TEST'},sheets:[{id:'sheet_1'}],
    groups:[],nets:[],layout:{mode:'mixed',unit:'mm',routes:[]},
    components:[{id:'r1',component_code:'TEST_R',variant_code:'01',
      sections:{BODY:{sheet_id:'sheet_1',position:{x:300,y:200},locked:true}}}]
  };
  return {schematic,library:[definition()]};
}

test('build workers use independent library snapshots, render previews and never store schemes',async t=>{
  const {app}=await fixture(t,{buildWorkers:2,buildQueue:0});
  const left=buildPayload('Проект А'),right=buildPayload('Проект Б');
  right.library[0].variants[0].sections[0].pins[0].x=-10;
  const [a,b]=await Promise.all([
    app.inject({method:'POST',url:'/api/schematics/build',payload:{...left,preview:true}}),
    app.inject({method:'POST',url:'/api/schematics/build',payload:{...right,options:{reset:true}}})
  ]);
  assert.equal(a.statusCode,200,a.body);
  assert.equal(b.statusCode,200,b.body);
  assert.equal(a.headers['cache-control'],'no-store');
  const aa=a.json<Resolved & {previews?:Record<string,string>}>(),bb=b.json<typeof aa>();
  assert.equal(aa.schematic.document.title,'Проект А');
  assert.equal(bb.schematic.document.title,'Проект Б');
  assert.equal(aa.sections[0].section.pins[0].x,-5);
  assert.equal(bb.sections[0].section.pins[0].x,-10);
  assert.deepEqual(aa.sections[0].position,{x:300,y:200});
  assert.notDeepEqual(bb.sections[0].position,{x:300,y:200});
  assert.match(aa.previews?.sheet_1??'',/<svg[^>]+/);
  assert.match(aa.previews?.sheet_1??'',/data-section-key="r1\/BODY"/);
  assert.equal(bb.previews,undefined);
  assert.deepEqual((await app.inject('/api/components')).json(),[]);
  assert.equal((await app.inject('/api/projects')).statusCode,404);
});

test('build API rejects malformed input and keeps the queue bounded',async t=>{
  const {app}=await fixture(t,{buildWorkers:1,buildQueue:0});
  const payload=buildPayload();
  const submit=(value:unknown)=>app.inject({method:'POST',url:'/api/schematics/build',payload:JSON.stringify(value),headers:{'content-type':'application/json'}});
  const [a,b]=await Promise.all([submit(payload),submit(payload)]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,503]);
  assert.equal((await submit({...payload,options:{reset:'true'}})).statusCode,400);
  assert.equal((await submit({...payload,library:[payload.library[0],payload.library[0]]})).statusCode,400);
  assert.equal((await submit({...payload,schematic:{nonsense:true}})).statusCode,400);
  assert.equal((await submit(payload)).statusCode,200);
});

function multiSheetPayload() {
  const read=(name:string)=>JSON.parse(readFileSync(new URL('../examples/'+name,import.meta.url),'utf8'));
  return {schematic:read('demo.json') as Schematic,library:read('library.json') as ComponentDefinition[],preview:true};
}

test('one request routes multiple sheets in parallel without changing SVG, routes or diagnostics',async t=>{
  const serial=(await fixture(t,{buildWorkers:1,buildQueue:0})).app;
  const parallel=(await fixture(t,{buildWorkers:2,buildQueue:0})).app;
  const req={method:'POST' as const,url:'/api/schematics/build',payload:multiSheetPayload()};
  const submit=async (app:typeof serial)=>{
    const response=await app.inject(req);
    assert.equal(response.statusCode,200,response.body);
    return response;
  };
  const a=await submit(serial), b=await submit(parallel);
  assert.equal(a.headers['x-schematic-routing-workers'],'1');
  assert.equal(b.headers['x-schematic-routing-workers'],'2');
  assert.deepEqual(a.json(),b.json());
  assert.ok(b.json<Resolved>().routes.some(r=>r.sheet_id==='sheet_1'));

  // At least one request has no spare worker to borrow. The other can borrow
  // one only if the first has already finished before its split is scheduled.
  const [c,d]=await Promise.all([submit(parallel),submit(parallel)]);
  assert.ok([c,d].some(r=>r.headers['x-schematic-routing-workers']==='1'));
  for (const r of [c,d]) {
    assert.deepEqual(r.json(),a.json());
  }
});

test('cancelling a build releases pool capacity and the next project succeeds',async t=>{
  const pool=new SchematicBuildPool(2,2);
  t.after(()=>pool.close());
  const cancel=new AbortController();
  const building=pool.run(multiSheetPayload(),cancel.signal);
  cancel.abort();
  await assert.rejects(building,{status:499});
  const next=await pool.run(multiSheetPayload(),new AbortController().signal);
  assert.ok(next.ok);
  assert.ok(next.routingWorkers>=1);
});

test('blank sheets do not displace occupied sheets from routing batches or change their order',()=>{
  const sheets=Array.from({length:200},(_,i)=>'sheet_'+i);
  const occupied=new Set(sheets.slice(0,8));
  const batches=routingBatches(sheets,occupied,8);
  assert.equal(batches.length,8);
  assert.deepEqual(batches.flat(),sheets);
  assert.ok(batches.every(batch=>batch.filter(sheet=>occupied.has(sheet)).length===1));
});

test('one project uses at most eight routing workers, with exactly the serial result',async t=>{
  const serial=(await fixture(t,{buildWorkers:1,buildQueue:2})).app;
  const parallel=(await fixture(t,{buildWorkers:10,buildQueue:2})).app;
  const payload=buildPayload('Десять листов');
  const {schematic}=payload;
  schematic.sheets=[];schematic.components=[];
  for(let i=1;i<=10;i++){
    const sheet_id='sheet_'+i, a='left_'+i, b='right_'+i;
    schematic.sheets.push({id:sheet_id});
    for (const [id,x] of [[a,60],[b,140]] as const) {
      schematic.components.push({id,component_code:'TEST_R',variant_code:'01',sections:{BODY:{sheet_id,position:{x,y:60},locked:true}}});
    }
    schematic.nets.push({id:'wire_'+i,render:'wire',pins:[{instance_id:a,number:'2'},{instance_id:b,number:'1'}]});
  }
  schematic.layout.routes.push({id:'fixed_1',net_id:'wire_1',sheet_id:'sheet_1',locked:true,points:[{x:75,y:62.5},{x:135,y:62.5}]});
  schematic.nets.push({id:'across',name:'ACROSS',render:'wire',pins:[{instance_id:'left_1',number:'1'},{instance_id:'right_10',number:'2'}]});
  const req={method:'POST' as const,url:'/api/schematics/build',payload:{...payload,preview:true}};
  const a=await serial.inject(req), b=await parallel.inject(req);
  assert.equal(a.statusCode,200,a.body);
  assert.equal(b.statusCode,200,b.body);
  assert.equal(a.headers['x-schematic-routing-workers'],'1');
  assert.equal(b.headers['x-schematic-routing-workers'],'8');
  assert.deepEqual(a.json(),b.json());
  const built=b.json<Resolved>();
  assert.deepEqual(built.issues,[]);
  assert.ok(built.routes.some(r=>r.id==='fixed_1'&&r.locked));
  assert.equal(built.labels.filter(l=>l.net_id==='across'&&l.continuation).length,2);
  const single=await parallel.inject({...req,payload:{...buildPayload(),preview:true}});
  assert.equal(single.statusCode,200,single.body);
  assert.equal(single.headers['x-schematic-routing-workers'],'1');
});

test('API creates, edits, catalogs, deletes and never reuses physical component codes', async t => {
  const {app}=await fixture(t);
  assert.equal((await app.inject('/api/health')).statusCode,200);
  assert.deepEqual((await app.inject('/api/components')).json(),[]);
  const c=definition();
  assert.equal((await app.inject({method:'POST',url:'/api/components',payload:c})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/components',payload:c})).statusCode,409);
  c.name='Новое имя';
  assert.equal((await app.inject({method:'PUT',url:'/api/components/TEST_R',payload:c})).statusCode,200);
  assert.equal((await app.inject('/api/components/TEST_R')).json().name,'Новое имя');
  const catalog=await app.inject('/api/docs/COMPONENT_CATALOG.md');
  assert.equal(catalog.statusCode,200);
  assert.match(catalog.body,/TEST_R/);
  assert.match(catalog.body,/BODY/);
  assert.match(catalog.body,/\| BODY \| 1, 2 \|/);
  assert.equal((await app.inject({method:'PUT',url:'/api/components/TEST_R',payload:{...c,component_code:'DIFFERENT'}})).statusCode,400);
  assert.equal((await app.inject({method:'DELETE',url:'/api/components/TEST_R'})).statusCode,204);
  assert.equal((await app.inject({method:'POST',url:'/api/components',payload:c})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/api/library/import',payload:{components:[c],replace:true}})).statusCode,409);
});

test('bulk import validates every record before writing and requires explicit replacement',async t=>{
  const {app}=await fixture(t);
  const invalid={...definition('BAD'),physical_pins:[{number:'1',name:'forbidden pin assignment'}]};
  const rejected=await app.inject({method:'POST',url:'/api/library/import',payload:{components:[definition('GOOD'),invalid]}});
  assert.equal(rejected.statusCode,400);
  assert.deepEqual((await app.inject('/api/components')).json(),[]);
  assert.equal((await app.inject({method:'POST',url:'/api/library/import',payload:{components:[definition('GOOD')]}})).statusCode,200);
  const changed={...definition('GOOD'),name:'Changed'};
  assert.equal((await app.inject({method:'POST',url:'/api/library/import',payload:{components:[definition('NEW'),changed]}})).statusCode,409);
  assert.equal((await app.inject('/api/components/NEW')).statusCode,404);
  assert.deepEqual((await app.inject({method:'POST',url:'/api/library/import',payload:{components:[changed],replace:true}})).json(),{added:0,replaced:1,skipped:0});
  const exported=(await app.inject('/api/library/export')).json();
  assert.equal(exported.format_version,'1.0');
  assert.equal(exported.components[0].name,'Changed');
});

test('restart preserves components and backup includes WAL commits; database stores no schemes',async()=>{
  const dataDir=mkdtempSync(path.join(tmpdir(),'gost-persist-'));
  let app=await buildServer({dataDir,seed:false});
  try {
    await app.inject({method:'POST',url:'/api/components',payload:definition()});
    const backup=await app.inject('/api/library/backup.sqlite');
    assert.equal(backup.statusCode,200);
    assert.equal(backup.rawPayload.subarray(0,16).toString(),'SQLite format 3\0');
    const backupFile=path.join(dataDir,'test-copy.sqlite');
    writeFileSync(backupFile,backup.rawPayload);
    const copy=new DatabaseSync(backupFile);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM components').get()?.n,1);
    assert.deepEqual(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),['component_codes','components','migrations','settings']);
    copy.close();
    await app.close();
    app=await buildServer({dataDir,seed:false});
    assert.equal((await app.inject('/api/components')).json().length,1);
    assert.equal((await app.inject({method:'POST',url:'/api/projects',payload:{secret:'scheme'}})).statusCode,404);
    assert.equal((await app.inject('/api/projects')).statusCode,404);
  } finally {await app.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('hostile fields, malformed JSON and unknown documents are rejected',async t=>{
  const {app}=await fixture(t);
  const c=definition();
  const bad={...c,variants:[{...c.variants[0],sections:[{...c.variants[0].sections[0],graphics:[{id:'unsafe',kind:'script',text:'alert(1)'}]}]}]};
  assert.equal((await app.inject({method:'POST',url:'/api/components',payload:bad})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/components',headers:{'content-type':'application/json'},payload:'{"x":'})).statusCode,400);
  assert.equal((await app.inject('/api/docs/not-found.md')).statusCode,404);
  assert.equal((await app.inject('/api/examples/..%2Fpackage.json')).statusCode,404);
  const schema=await app.inject('/api/schemas/component.json');
  assert.equal(schema.statusCode,200);
  assert.equal(schema.json().type,'object');
});

test('JSON library export preserves deleted-code reservations on a fresh install',async t=>{
  const {app}=await fixture(t);
  await app.inject({method:'POST',url:'/api/components',payload:definition('DELETED')});
  await app.inject({method:'DELETE',url:'/api/components/DELETED'});
  const exported=(await app.inject('/api/library/export')).json();
  assert.deepEqual(exported.reserved_codes,['DELETED']);
  const destination=mkdtempSync(path.join(tmpdir(),'gost-restore-'));
  const restored=await buildServer({dataDir:destination,seed:false});
  try{
    assert.equal((await restored.inject({method:'POST',url:'/api/library/import',payload:exported})).statusCode,200);
    assert.equal((await restored.inject({method:'POST',url:'/api/components',payload:definition('DELETED')})).statusCode,409);
  } finally {await restored.close();rmSync(destination,{recursive:true,force:true});}
});


test('initial seed is applied once and never restores a deliberately emptied library',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'gost-seed-'));
  const projectDir=path.join(folder,'project');
  const dataDir=path.join(folder,'data');
  mkdirSync(path.join(projectDir,'examples'),{recursive:true});
  writeFileSync(path.join(projectDir,'examples','library.json'),JSON.stringify([definition('SEED')]));
  let app=await buildServer({dataDir,projectDir});
  try {
    assert.equal((await app.inject('/api/components')).json().length,1);
    await app.inject({method:'DELETE',url:'/api/components/SEED'});
    await app.close();
    app=await buildServer({dataDir,projectDir});
    assert.deepEqual((await app.inject('/api/components')).json(),[]);
    assert.equal((await app.inject({method:'POST',url:'/api/components',payload:definition('SEED')})).statusCode,409);
  } finally {await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('routing cache reuses unaffected sheets and invalidates changed geometry and continuations',async()=>{
 const {SheetRoutingCache}=await import('../apps/server/src/sheet-routing-cache.js');
 const {routeSheetBatch,mergeRoutedSheets,routeSchematic}=await import('../packages/core/src/routing.js');
 const {buildSchematic}=await import('../packages/core/src/layout.js');
 const {schematic,library}=multiSheetPayload(),cache=new SheetRoutingCache();
 async function build(input:Schematic){
  const misses:string[]=[];
  const result=await buildSchematic(input,library,{},(s,sections)=>{
   const memo=cache.memo(s,sections);
   const batch=routeSheetBatch(s,sections,s.sheets.map(sh=>sh.id),(sheet,compute)=>memo(sheet,()=>{misses.push(sheet);return compute();}));
   const cached=mergeRoutedSheets(s,[batch]);
   assert.deepEqual(cached,routeSchematic(s,sections));return cached;
  });
  return {result,misses};
 }
 const first=await build(schematic);
 assert.deepEqual(first.misses,['sheet_1','sheet_2']);
 const moved=structuredClone(first.result.schematic);
 moved.components.find(c=>c.id==='r_input')!.sections.BODY.position={x:70,y:65};
 assert.deepEqual((await build(moved)).misses,['sheet_1']);
 const swapped=structuredClone(moved);
 swapped.sheets.reverse();
 assert.deepEqual((await build(swapped)).misses,['sheet_2','sheet_1']);
});

test('an existing stock resistor is presented at 10 by 4 mm without a database rewrite',async t=>{
 const {app,dataDir}=await fixture(t);
 const def=(JSON.parse(readFileSync(new URL('../examples/library.json',import.meta.url),'utf8')) as ComponentDefinition[]).find(d=>d.component_code==='GEN_R')!;
 const old=structuredClone(def);
 Object.assign(old.variants[0].sections[0].graphics[0],{height:5,y:0});
 const created=await app.inject({method:'POST',url:'/api/components',payload:old});
 assert.equal(created.statusCode,201);
 assert.deepEqual((await app.inject('/api/components/GEN_R')).json(),def);
 assert.deepEqual((await app.inject('/api/library/export')).json().components,[def]);
 const db=new DatabaseSync(path.join(dataDir,'library.sqlite'),{readOnly:true});
 try{
  const row=db.prepare('SELECT definition FROM components WHERE code=?').get('GEN_R')!;
  assert.deepEqual(JSON.parse(String(row.definition)),old);
 }finally{db.close();}
});

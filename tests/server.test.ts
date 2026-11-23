import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildServer } from '../apps/server/src/server.js';
import type { ComponentDefinition } from '../packages/core/src/types.js';

const definition = (code='TEST_R'): ComponentDefinition => ({
  format_version:'1.0',component_code:code,name:'Тестовый резистор',category:'passive',positional_prefix:'R',physical_pins:[{number:'1'},{number:'2'}],
  variants:[{variant_code:'01',name:'Основной',sections:[{section_id:'BODY',graphics:[{id:'rect',kind:'rectangle',x:0,y:0,width:10,height:5}],pins:[{number:'1',x:-5,y:2.5,side:'left'},{number:'2',x:15,y:2.5,side:'right'}]}]}]
});

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(path.join(tmpdir(),'gost-server-'));
  const app = await buildServer({dataDir,seed:false});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  return {app,dataDir};
}

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

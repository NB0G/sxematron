import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSchematic,emptySchematic,exportSheets,renderSheet,validateSchematic} from '../packages/core/src/index.js';
import {auditConnections} from '../packages/core/src/connections.js';
import type {Library,Schematic} from '../packages/core/src/types.js';

const lib:Library=JSON.parse(readFileSync(new URL('../examples/library.json',import.meta.url),'utf8'));
function add(s:Schematic,id:string,sheet:string,x:number,y:number,rotation=0){
 s.components.push({id,component_code:'GEN_R',variant_code:'01',sections:{BODY:{sheet_id:sheet,position:{x,y},rotation,locked:true}}});
 return {instance_id:id,number:'2'};
}

test('one pin on each of four sheets has reciprocal point-to-point contacts, including two at intermediate pins',async()=>{
 const s=emptySchematic();s.sheets=['a','b','c','d'].map(id=>({id}));
 const pins=s.sheets.map((sh,i)=>add(s,'dev'+i,sh.id,125,80));s.nets=[{id:'data',render:'auto',pins}];
 const r=await buildSchematic(s,lib);
 assert.deepEqual(r.issues,[]);assert.deepEqual(r.schematic.nets,s.nets);
 assert.deepEqual(r.labels.map(l=>[l.sheet_id,l.peerSheet]),[['a','b'],['b','a'],['b','c'],['c','b'],['c','d'],['d','c']]);
 assert.ok(r.labels.every(l=>l.continuation&&/^data \(л\.\d\)$/.test(l.text)));
 assert.equal(new Set(r.routes.map(w=>w.id)).size,r.routes.length);
 for(const l of r.labels)assert.ok(r.routes.some(w=>w.sheet_id===l.sheet_id&&w.net_id===l.net_id&&w.points.at(-1)?.x===l.point.x&&w.points.at(-1)?.y===l.point.y));
});

test('a wired ground island receives one vertical, unnamed symbol; isolated grounds retain an electrical identity',async()=>{
 const s=emptySchematic();s.sheets.push({id:'b'});
 s.nets=[{id:'silent_ground',name:'do-not-print-ground',role:'ground',render:'wire',pins:[
  add(s,'left','sheet_1',70,80),{...add(s,'right','sheet_1',140,80),number:'1'},add(s,'remote','b',100,80,90)]}];
 const r=await buildSchematic(s,lib);assert.deepEqual(r.issues,[]);assert.equal(r.labels.length,2);
 for(const l of r.labels){assert.equal(l.text,'');assert.equal(l.approach,'down');assert.equal(l.peerSheet,undefined);assert.doesNotMatch(renderSheet(r,l.sheet_id),/do-not-print-ground/);}
});

test('density changes only automatic rendering and the clearance knob changes the geometric obstacle',async()=>{
 const s=emptySchematic(),a=add(s,'a','sheet_1',55,60),b={...add(s,'b','sheet_1',160,60),number:'1'};
 s.nets=[{id:'n',pins:[a,b],render:'auto'}];s.layout.settings={wireDensity:0};
 assert.equal((await buildSchematic(s,lib)).labels.length,2);
 s.layout.settings.wireDensity=100;assert.equal((await buildSchematic(s,lib)).labels.length,0);
 s.nets[0].render='wire';s.layout.settings.wireDensity=0;assert.equal((await buildSchematic(s,lib)).labels.length,0);
 add(s,'obstacle','sheet_1',105,56.5);
 s.layout.settings.bodyClearance=.5;const low=await buildSchematic(s,lib);
 s.layout.settings.bodyClearance=5;const high=await buildSchematic(s,lib);
 assert.deepEqual(low.issues,[]);assert.deepEqual(high.issues,[]);assert.notDeepEqual(low.routes,high.routes);
});

test('an impossible mandatory label cannot leave an apparently valid printable sheet',async()=>{
 const s=emptySchematic();const p=add(s,'a','sheet_1',55,60);s.nets=[{id:'n',pins:[p],render:'label'}];
 s.layout.labels=[{net_id:'n',...p,position:{x:10,y:4},locked:true}];
 const r=await buildSchematic(s,lib);
 assert.ok(r.issues.some(i=>i.severity==='error'&&i.code==='LABEL_CROWDED'));
});

test('a missing return port is diagnosed and the unmatched arrow is hidden',async()=>{
 const s=emptySchematic();s.sheets.push({id:'blank'},{id:'peer'});
 const a=add(s,'a','sheet_1',100,95),b=add(s,'b','peer',160,95);
 s.nets=[{id:'broken_pair',render:'label',pins:[a,b]}];
 s.layout.labels=[{...b,net_id:'broken_pair',peerSheet:'sheet_1',position:{x:10,y:4},locked:true}];
 const r=await buildSchematic(s,lib);
 assert.equal(r.quality?.unpairedPorts,1);
 assert.ok(r.issues.some(issue=>issue.code==='UNPAIRED_PORT'&&issue.sheet_id==='sheet_1'));
 assert.ok(r.issues.some(issue=>issue.code==='LABEL_CROWDED'&&issue.reason==='LABEL_FOOTPRINT'&&issue.pins?.[0].instance_id==='b'));
 assert.doesNotMatch(renderSheet(r,'sheet_1'),/broken_pair/);
 assert.throws(()=>exportSheets(r),/Экспорт заблокирован/);
});

test('only attached labels of the same ID on the same sheet join conductor islands',async()=>{
 const s=emptySchematic();
 const a=add(s,'a','sheet_1',75,80),b=add(s,'b','sheet_1',150,110),c=add(s,'c','sheet_1',210,75),d=add(s,'d','sheet_1',285,110);
 s.nets=[{id:'one',name:'same',render:'label',pins:[a,b]},{id:'two',name:'same',render:'label',pins:[c,d]}];
 const r=await buildSchematic(s,lib);
 assert.deepEqual(r.issues,[]);
 assert.equal(auditConnections(r).disconnectedGroups,0);
 const changed=structuredClone(r);
 const label=changed.labels.find(l=>l.net_id==='one')!;
 label.point={x:11,y:11};
 const audit=auditConnections(changed);
 assert.equal(audit.orphanLabels,1);
 assert.equal(audit.disconnectedGroups,1);
 assert.equal(audit.missingTerminals,0);
});

test('adjacent pin labels fit with straight leads on all rotations and both reflections',async()=>{
 const d=structuredClone(lib.find(d=>d.component_code==='GEN_R')!);
 d.component_code='PIN_ROW';
 const section=d.variants[0].sections[0];
 section.graphics=[{id:'outline',kind:'rectangle',x:0,y:0,width:20,height:48}];
 section.pins=Array.from({length:8},(_,i)=>({number:String(i+1),x:25,y:4+5.5*i,side:'right',length:5}));
 d.physical_pins=section.pins.map(({number})=>({number}));
 for(const rotation of [0,90,180,270])for(const mirror of [false,true]){
  const s=emptySchematic();
  s.components=[{id:'row',component_code:d.component_code,variant_code:'01',sections:{BODY:{sheet_id:'sheet_1',position:{x:185,y:120},rotation,mirror,locked:true}}}];
  s.nets=section.pins.map(({number},index)=>({id:'n'+number,name:index%3===0?'LONG_SIGNAL_'+number:'S'+number,render:'label',pins:[{instance_id:'row',number}]}));
  const r=await buildSchematic(s,[...lib,d]);
  assert.deepEqual(r.issues,[]);
  assert.equal(r.labels.length,8);
  if(rotation%180===0)assert.equal(r.quality?.bends,0);
  for(const label of r.labels){
   const route=r.routes.find(w=>w.net_id===label.net_id)!;
   const [a,b]=route.points.slice(-2);
   assert.deepEqual(b,label.point);
   assert.equal(label.approach,a.x===b.x?(a.y<b.y?'down':'up'):(a.x<b.x?'right':'left'));
  }
 }
});

test('an exported T gets a dot, while a foreign segment crossing its point is detected',async()=>{
 const s=emptySchematic();
 const a=add(s,'a','sheet_1',60,80),b={...add(s,'b','sheet_1',170,80),number:'1'},c=add(s,'c','sheet_1',100,110,270);
 s.nets=[{id:'t',render:'wire',pins:[a,b,c]}];
 const r=await buildSchematic(s,lib);
 assert.deepEqual(r.issues,[]);
 assert.match(renderSheet(r,'sheet_1'),/<circle cx="102\.5" cy="82\.5" r="0\.8"/);
 const foreign={id:'other',net_id:'other',sheet_id:'sheet_1',points:[{x:90,y:82.5},{x:102.5,y:82.5},{x:102.5,y:70}]};
 const audit=auditConnections({...r,routes:[...r.routes,foreign]});
 assert.ok(audit.issues.some(i=>i.code==='AMBIGUOUS_CROSSING'&&i.point&&i.sheet_id==='sheet_1'));
});

test('more passes retain the best available drawing and do not alter the netlist',async()=>{
 const source=JSON.parse(readFileSync(new URL('../examples/auto.json',import.meta.url),'utf8')) as Schematic;
 let last=Infinity;
 for(const iterations of [1,2,4,8]){
  const s=structuredClone(source);s.layout.settings={iterations};
  const r=await buildSchematic(s,lib);
  assert.deepEqual(r.issues.filter(i=>i.severity==='error'),[]);
  assert.deepEqual(r.schematic.nets,source.nets);
  assert.ok(r.quality!.cost<=last);
  last=r.quality!.cost;
  assert.deepEqual(validateSchematic(r.schematic,lib),[]);
 }
});

test('reordering sheets preserves the ID and manual position of a still-valid pair',async()=>{
 const s=emptySchematic();s.sheets=['a','blank','b','c'].map(id=>({id}));
 const a=add(s,'a','a',100,95),b=add(s,'b','b',160,95),c=add(s,'c','c',170,95);
 s.nets=[{id:'ordered',render:'label',pins:[a,b,c]}];
 const before=await buildSchematic(s,lib);
 const anchor=before.labels.find(l=>l.sheet_id==='b'&&l.peerSheet==='c')!;
 const position={x:220,y:105};
 s.layout.labels=[{...b,net_id:'ordered',peerSheet:'c',position,locked:true}];
 s.sheets.reverse();
 s.nets[0].pins.reverse();
 const after=await buildSchematic(s,lib);
 assert.deepEqual(after.issues,[]);
 const moved=after.labels.find(l=>l.sheet_id==='b'&&l.peerSheet==='c')!;
 assert.equal(moved.pairId,anchor.pairId);
 assert.deepEqual(moved.point,position);
 assert.equal(moved.text,'ordered (л.1)');
});

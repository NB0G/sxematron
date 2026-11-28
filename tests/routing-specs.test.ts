import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSchematic,emptySchematic,renderSheet} from '../packages/core/src/index.js';
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSchematic, emptySchematic, exportSheets, pinPosition, pointOnSegment, renderSheet } from '../packages/core/src/index.js';
import type { Instance, Library, Point, Schematic } from '../packages/core/src/types.js';

const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../examples/${name}`,import.meta.url),'utf8'));
const library=fixture('library.json') as Library;
const component=(id:string,x:number,y:number,rotation=0):Instance=>({
 id,component_code:'GEN_R',variant_code:'01',
 sections:{BODY:{sheet_id:'sheet_1',position:{x,y},locked:true,rotation}},
});
const length=(points:Point[])=>points.slice(1).reduce((sum,p,i)=>
 sum+Math.abs(points[i].x-p.x)+Math.abs(points[i].y-p.y),0);

test('clear perpendicular leads produce one bend at exact pin coordinates, not grid jogs',async()=>{
 const s=emptySchematic();
 s.components=[component('a',60.1,60.6),component('b',140.3,100.8,90)];
 s.nets=[{id:'n',render:'wire',pins:[{instance_id:'a',number:'2'},{instance_id:'b',number:'1'}]}];
 const result=await buildSchematic(s,library);
 assert.deepEqual(result.issues,[]);
 const [a,b]=result.sections;
 const start=pinPosition(a,a.section.pins.find(p=>p.number==='2')!);
 const end=pinPosition(b,b.section.pins.find(p=>p.number==='1')!);
 assert.deepEqual(result.routes.map(r=>r.points),[[start,{x:end.x,y:start.y},end]]);
});

test('moving a terminal rebuilds its branch once, joining the shortest projection onto the existing trunk',async()=>{
 const s=emptySchematic();
 s.components=[component('a',60,60),component('b',140,60),component('c',100,130,90)];
 s.nets=[{id:'n',render:'wire',pins:[{instance_id:'a',number:'2'},{instance_id:'b',number:'1'},{instance_id:'c',number:'1'}]}];
 const original=await buildSchematic(s,library);
 const next=structuredClone(original.schematic);
 next.components[2].sections.BODY.position={x:106.2,y:110.5};
 const result=await buildSchematic(next,library);
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.schematic.nets,s.nets);
 assert.equal(result.routes.length,2);
 const [trunk,branch]=result.routes;
 assert.deepEqual(trunk.points,original.routes[0].points);
 assert.equal(branch.points.length,2);
 assert.equal(branch.points[0].x,branch.points[1].x);
 assert.equal(length(branch.points),43);
 assert.ok(!pointOnSegment(branch.points[0],trunk.points[0],trunk.points[1]));
 const join=branch.points[1];
 assert.ok(pointOnSegment(join,trunk.points[0],trunk.points[1]));
 const dots=renderSheet(result,'sheet_1').match(/<circle[^>]*r="0\.8"[^>]*>/g)??[];
 assert.equal(dots.length,1);
});

test('import example 00 preserves terminal graph and lock positions without routing or label warnings',async()=>{
 const s=fixture('00_smoke_import.json') as Schematic;
 const result=await buildSchematic(s,library);
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.schematic.nets,s.nets);
 for(const component of s.components)for(const [id,placement] of Object.entries(component.sections)){
  if(placement.locked)assert.deepEqual(result.sections.find(a=>a.key===`${component.id}/${id}`)?.position,placement.position);
 }
 for(const net of s.nets)for(const terminal of net.pins){
  const section=result.sections.find(a=>a.instance.id===terminal.instance_id&&a.section.pins.some(p=>p.number===terminal.number))!;
  const pin=pinPosition(section,section.section.pins.find(p=>p.number===terminal.number)!);
  assert.ok(
   result.labels.some(l=>l.net_id===net.id&&l.pin?.instance_id===terminal.instance_id&&l.pin?.number===terminal.number)||
   result.routes.some(r=>r.net_id===net.id&&r.points.slice(1).some((p,i)=>pointOnSegment(pin,r.points[i],p))),
   `missing output for ${net.id}: ${terminal.instance_id}.${terminal.number}`,
  );
 }
 assert.ok(exportSheets(result).bytes.length>0);
});

test('long identifiers generate short, distinct route IDs that survive JSON import',async()=>{
 const s=emptySchematic(),sheet='sheet_'+'x'.repeat(94),net='n'.repeat(100);
 s.sheets[0].id=sheet;
 s.components=[component('a',60,60),component('b',140,60)];
 for(const c of s.components)c.sections.BODY.sheet_id=sheet;
 s.nets=[{id:net,render:'wire',pins:[{instance_id:'a',number:'2'},{instance_id:'b',number:'1'}]}];
 const built=await buildSchematic(s,library);
 assert.deepEqual(built.issues,[]);
 assert.ok(built.routes.length&&built.routes.every(r=>r.id.length<=100));
 const again=await buildSchematic(JSON.parse(JSON.stringify(built.schematic)),library);
 assert.deepEqual(again,built);
});

test('locked wire passing through a foreign component is warned about but not moved',async()=>{
 const s=emptySchematic();s.components=[component('a',60,60),component('b',140,60),component('obstacle',100,60)];
 s.nets=[{id:'signal',render:'wire',pins:[{instance_id:'a',number:'2'},{instance_id:'b',number:'1'}]}];
 const full=await buildSchematic(s,library);
 const [a,b]=full.sections,p=(section:typeof a,num:string)=>pinPosition(section,section.section.pins.find(p=>p.number===num)!);
 const manual={id:'manual',net_id:'signal',sheet_id:'sheet_1',points:[p(a,'2'),p(b,'1')],locked:true};
 s.layout.routes=[manual];const r=await buildSchematic(s,library);
 assert.deepEqual(r.issues.map(i=>i.code),['LOCKED_ROUTE_OBSTACLE']);
 assert.deepEqual(r.routes,[manual]);
});

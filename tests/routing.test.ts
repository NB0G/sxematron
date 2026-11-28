import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSchematic, emptySchematic, exportSheets, pinPosition, placedBodyBounds, pointOnSegment, renderSheet } from '../packages/core/src/index.js';
import { BODY_CLEARANCE } from '../packages/core/src/routing.js';
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

test('ground is approached from above even with a horizontal pin or a fixed label position',async()=>{
 const s=emptySchematic();
 s.components=[component('a',60,60)];
 s.nets=[{id:'ground',name:'GND',render:'label',role:'ground',pins:[{instance_id:'a',number:'2'}]}];
 for(const manual of [undefined,{x:95,y:80}]){
  s.layout.labels=manual?[{net_id:'ground',instance_id:'a',number:'2',position:manual,locked:true}]:[];
  const r=await buildSchematic(s,library);
  assert.deepEqual(r.issues,[]);
  const marker=r.labels[0];
  assert.equal(marker.approach,'down');
  if(manual)assert.deepEqual(marker.point,manual);
  const [a,b]=r.routes[0].points.slice(-2);
  assert.deepEqual(b,marker.point);
  assert.equal(a.x,b.x);
  assert.ok(b.y-a.y>=3.75);
  assert.match(renderSheet(r,'sheet_1'),new RegExp(`M ${b.x} ${b.y} v 1.25`));
 }
});

test('arrows align with incoming wire segments, and same-net continuation markers avoid existing wires',async()=>{
 const s=emptySchematic();
 s.sheets.push({id:'second'});
 s.components=[component('a',60,60),component('b',145,60),component('c',75,105,90)];
 s.components[2].sections.BODY.sheet_id='second';
 s.nets=[{id:'x',name:'VMID',render:'wire',pins:[{instance_id:'a',number:'2'},{instance_id:'b',number:'1'},{instance_id:'c',number:'1'}]}];
 const r=await buildSchematic(s,library);
 assert.deepEqual(r.issues,[]);
 assert.equal(r.labels.length,2);
 for(const l of r.labels){
  const wire=r.routes.find(w=>w.sheet_id===l.sheet_id&&w.id.startsWith('label_'))!;
  const [a,b]=wire.points.slice(-2);
  assert.deepEqual(b,l.point);
  assert.ok(a.y===b.y||a.x===b.x);
  assert.ok(length([a,b])>=3.75);
  assert.equal(l.approach,a.x===b.x?(b.y>a.y?'down':'up'):(b.x>a.x?'right':'left'));
  assert.ok(r.routes.filter(w=>w.sheet_id===l.sheet_id&&w!==wire).every(w=>w.points.slice(1).every((p,i)=>!pointOnSegment(l.point,w.points[i],p))));
 }
 assert.match(renderSheet(r,'second',{interactive:true}),/<g transform="rotate\(-90\)"><text[^>]+>1<\/text><\/g>/);
});

test('automatic wire keeps clearance from an unrelated body, even when the straight line touches it',async()=>{
 const s=emptySchematic();
 s.components=[component('left',55,60),component('right',160,60),component('obstacle',105,57.5)];
 s.nets=[{id:'signal',render:'wire',pins:[{instance_id:'left',number:'2'},{instance_id:'right',number:'1'}]}];
 const r=await buildSchematic(s,library);
 assert.deepEqual(r.issues,[]);
 const box=placedBodyBounds(r.sections[2],BODY_CLEARANCE)!;
 for(const w of r.routes)for(let i=1;i<w.points.length;i++){
  const [a,b]=[w.points[i-1],w.points[i]];
  const crosses=a.x===b.x?a.x>box.x&&a.x<box.right&&Math.max(a.y,b.y)>box.y&&Math.min(a.y,b.y)<box.bottom:
   a.y>box.y&&a.y<box.bottom&&Math.max(a.x,b.x)>box.x&&Math.min(a.x,b.x)<box.right;
  assert.equal(crosses,false,`case clearance broken by ${JSON.stringify([a,b])}`);
 }
 assert.ok(r.routes[0].points.length>2);
});

test('power-to-ground capacitors without fixed coordinates pack in a compact block',async()=>{
 const s=emptySchematic();
 s.components=Array.from({length:10},(_,i)=>({id:'c'+i,component_code:'GEN_C',variant_code:'01',sections:{BODY:{}}}));
 s.nets=[
  {id:'vcc',name:'3V3',role:'positive_supply',render:'label',pins:s.components.map(c=>({instance_id:c.id,number:'1'}))},
  {id:'ground',name:'GND',role:'ground',render:'label',pins:s.components.map(c=>({instance_id:c.id,number:'2'}))}
 ];
 const r=await buildSchematic(s,library);
 assert.equal(r.schematic.sheets.length,1);
 assert.deepEqual(r.issues,[]);
 assert.ok(r.sections.every(a=>a.rotation%180===90));
 const xs=r.sections.map(a=>a.position.x);
 assert.ok(Math.max(...xs)-Math.min(...xs)<125);
 assert.equal(r.labels.filter(l=>l.approach==='down').length,10);
});

test('different nets get three millimetres of parallel spacing, without changing a fixed wire',async()=>{
 const s=emptySchematic();
 s.components=[component('first',65,87.5),component('last',180,87.5),component('left',35,89.5),component('right',230,89.5)];
 s.nets=[
  {id:'locked',render:'wire',pins:[{instance_id:'first',number:'2'},{instance_id:'last',number:'1'}]},
  {id:'free',render:'wire',pins:[{instance_id:'left',number:'2'},{instance_id:'right',number:'1'}]}
 ];
 const locked={id:'original',net_id:'locked',sheet_id:'sheet_1',locked:true,points:[{x:80,y:90},{x:175,y:90}]};
 s.layout.routes=[locked];
 const r=await buildSchematic(s,library);
 assert.deepEqual(r.issues,[]);
 assert.deepEqual(r.routes[0],locked);
 const path=r.routes.find(w=>w.net_id==='free')!.points;
 for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i];
  if(a.y===b.y&&Math.min(a.x,b.x)<175&&Math.max(a.x,b.x)>80)assert.ok(Math.abs(a.y-90)>=3);
 }
 assert.ok(path.length>2);
});

test('a left facing contact prefers a direct left-side marker instead of a loop around its own body',async()=>{
 const s=emptySchematic();
 s.components=[component('a',140,80)];
 s.nets=[{id:'shield',name:'SHIELD',render:'label',pins:[{instance_id:'a',number:'1'}]}];
 const r=await buildSchematic(s,library);
 assert.deepEqual(r.issues,[]);
 const label=r.labels[0],pin=pinPosition(r.sections[0],r.sections[0].section.pins[0]);
 assert.equal(label.approach,'left');
 assert.ok(label.point.x<pin.x);
 assert.equal(label.point.y,pin.y);
 assert.deepEqual(r.routes[0].points,[pin,label.point]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSchematic, emptySchematic, validateComponent, validateSchematic, expandRepeats, pinPosition, pointOnSegment, renderSheet, exportSheets, assignDesignators } from '../packages/core/src/index.js';
import type { ComponentDefinition, Schematic, Instance, Resolved, Primitive, WireRoute } from '../packages/core/src/types.js';

const resistor:ComponentDefinition={format_version:'1.0',component_code:'TEST_R',name:'Синтетический резистор',category:'passive',positional_prefix:'R',physical_pins:[{number:'1'},{number:'2'}],variants:[{variant_code:'01',name:'Основной',sections:[{section_id:'BODY',graphics:[{id:'body',kind:'rectangle',x:0,y:0,width:10,height:5}],pins:[{number:'1',x:-5,y:2.5,side:'left'},{number:'2',x:15,y:2.5,side:'right'}]}]}]};
const dual:ComponentDefinition={format_version:'1.0',component_code:'TEST_DUAL',name:'Синтетический многосекционный',category:'ic',positional_prefix:'DA',physical_pins:Array.from({length:6},(_,i)=>({number:String(i+1)})),variants:[{variant_code:'SPLIT',name:'A, B, питание',sections:['A','B','POWER'].map((id,i)=>({section_id:id,graphics:[{id:'body',kind:'rectangle' as const,x:0,y:0,width:20,height:15}],pins:[{number:String(i*2+1),x:-5,y:7.5,side:'left' as const},{number:String(i*2+2),x:25,y:7.5,side:'right' as const}]}))}]};
const lib=[resistor,dual];
const placed=(id:string,x:number,y:number):Instance=>({id,component_code:'TEST_R',variant_code:'01',sections:{BODY:{sheet_id:'sheet_1',position:{x,y},locked:true}}});
function wired():Schematic {const s=emptySchematic();s.document={title:'Проверка печати А3',designation:'TEST.0001.Э3',author:'Тест'};s.components=[placed('left',60,60),placed('right',140,60)];s.nets=[{id:'signal',name:'SIGNAL',render:'wire',pins:[{instance_id:'left',number:'2'},{instance_id:'right',number:'1'}]}];return s;}
const errors=(r:Resolved)=>r.issues.filter(i=>i.severity==='error');
function covers(res:Resolved,id:string,number:string,net:string){const section=res.sections.find(a=>a.instance.id===id&&a.section.pins.some(p=>p.number===number));assert.ok(section);const pin=section.section.pins.find(p=>p.number===number)!;const point=pinPosition(section,pin);return res.routes.filter(r=>r.net_id===net&&r.sheet_id===section.sheet_id).some(r=>r.points.slice(1).some((p,i)=>pointOnSegment(point,r.points[i],p)));}

test('every section of one physical component is rendered across pages with one designator',async()=>{
 const s=emptySchematic();s.sheets.push({id:'sheet_2'});s.components=[{id:'chip',component_code:'TEST_DUAL',variant_code:'SPLIT',sections:{A:{sheet_id:'sheet_1',position:{x:80,y:60},locked:true},B:{sheet_id:'sheet_1',position:{x:160,y:60},locked:true},POWER:{sheet_id:'sheet_2',position:{x:80,y:60},locked:true}}}];
 const result=await buildSchematic(s,lib);assert.deepEqual(errors(result),[]);assert.equal(result.schematic.components.length,1);assert.equal(result.sections.length,3);assert.deepEqual(result.sections.map(a=>a.section.section_id),['A','B','POWER']);assert.deepEqual(new Set(result.sections.map(a=>a.instance.designator)),new Set(['DA1']));assert.equal(result.sections.find(a=>a.section.section_id==='POWER')?.sheet_id,'sheet_2');
 // Omitted placement objects do not hide unconnected mandatory sections.
 s.components[0].sections={};const auto=await buildSchematic(s,lib);assert.equal(auto.sections.length,3);assert.deepEqual(Object.keys(auto.schematic.components[0].sections).sort(),['A','B','POWER']);
});

test('manual drag and JSON round trip preserve electrical graph and fixed positions',async()=>{
 const first=await buildSchematic(wired(),lib);assert.deepEqual(errors(first),[]);assert.ok(covers(first,'left','2','signal'));assert.ok(covers(first,'right','1','signal'));
 const moved=JSON.parse(JSON.stringify(first.schematic)) as Schematic;moved.components[1].sections.BODY.position={x:160,y:100};moved.components[1].sections.BODY.locked=true;
 const next=await buildSchematic(moved,lib);assert.deepEqual(errors(next),[]);assert.deepEqual(next.schematic.nets,first.schematic.nets);assert.deepEqual(next.sections.find(a=>a.instance.id==='right')?.position,{x:160,y:100});assert.ok(covers(next,'right','1','signal'));
 const reload=await buildSchematic(JSON.parse(JSON.stringify(next.schematic)),lib);assert.deepEqual(reload.schematic,next.schematic);assert.deepEqual(reload.routes,next.routes);
});

test('automatic layout and routes are deterministic and do not mutate input',async()=>{
 const s=wired();for(const c of s.components)c.sections.BODY={};s.components.push({...placed('third',0,0),sections:{BODY:{}}});s.groups=[{id:'g',tag:'stage'}];s.components.forEach(c=>c.tag='stage');s.nets[0].render='auto';const snapshot=structuredClone(s);
 const a=await buildSchematic(s,lib),b=await buildSchematic(s,lib);assert.deepEqual(errors(a),[]);assert.deepEqual(a.schematic,b.schematic);assert.deepEqual(a.routes,b.routes);assert.deepEqual(s,snapshot);
});

test('locked anchors and valid manual routes survive reimport; disconnected moved route is rejected',async()=>{
 const s=wired();const route:WireRoute={id:'manual',net_id:'signal',sheet_id:'sheet_1',points:[{x:75,y:62.5},{x:135,y:62.5}],locked:true};s.layout.routes=[route];
 const result=await buildSchematic(s,lib);assert.deepEqual(errors(result),[]);assert.deepEqual(result.routes.find(r=>r.id==='manual'),route);assert.deepEqual(result.sections[0].position,{x:60,y:60});
 const changed=structuredClone(result.schematic);changed.components[1].sections.BODY.position={x:140,y:100};const broken=await buildSchematic(changed,lib);assert.ok(broken.issues.some(i=>i.code==='LOCKED_ROUTE_DISCONNECTED'&&i.severity==='error'));assert.throws(()=>exportSheets(broken));
});

test('locked route fragments must form one connected tree, not merely touch each terminal',async()=>{
 const s=wired();s.layout.routes=[{id:'a',net_id:'signal',sheet_id:'sheet_1',points:[{x:75,y:62.5},{x:85,y:62.5}],locked:true},{id:'b',net_id:'signal',sheet_id:'sheet_1',points:[{x:125,y:62.5},{x:135,y:62.5}],locked:true}];
 const result=await buildSchematic(s,lib);assert.ok(result.issues.some(i=>i.code==='LOCKED_ROUTE_DISCONNECTED'&&i.severity==='error'),'disjoint fragments currently pass endpoint coverage but must not represent a connected wire net');
});

test('wire, label and automatic intersheet rendering preserve exactly the same terminal sets',async()=>{
 const s=wired();const wire=await buildSchematic(s,lib);s.nets[0].render='label';const labels=await buildSchematic(s,lib);assert.deepEqual(errors(labels),[]);assert.equal(labels.labels.length,2);assert.deepEqual(labels.schematic.nets[0].pins,wire.schematic.nets[0].pins);
 s.sheets.push({id:'sheet_2'});s.components[1].sections.BODY.sheet_id='sheet_2';s.nets[0].render='auto';const multi=await buildSchematic(s,lib);assert.deepEqual(errors(multi),[]);assert.ok(multi.labels.every(l=>l.continuation));assert.ok(multi.labels.some(l=>l.sheet_id==='sheet_1'&&l.text.includes('2')));assert.ok(multi.labels.some(l=>l.sheet_id==='sheet_2'&&l.text.includes('1')));assert.deepEqual(multi.schematic.nets[0].pins,wire.schematic.nets[0].pins);
});

test('repeated stages isolate local nets and join only through explicit shared ports',()=>{
 const s=emptySchematic();s.components=[placed('source',60,60)];s.nets=[{id:'supply',name:'V',render:'label',pins:[{instance_id:'source',number:'1'}]}];s.templates=[{id:'stage',components:[{id:'r1',component_code:'TEST_R',variant_code:'01',sections:{BODY:{}}},{id:'r2',component_code:'TEST_R',variant_code:'01',sections:{BODY:{}}}],nets:[{id:'local',name:'SIGNAL',render:'wire',pins:[{instance_id:'r1',number:'2'},{instance_id:'r2',number:'1'}]}],ports:{power:[{instance_id:'r1',number:'1'}]}}];s.repeat_instances=[{id:'channels',template_id:'stage',count:3,connections:{power:'supply'}}];
 assert.deepEqual(validateSchematic(s,lib),[]);const {schematic:expanded,issues}=expandRepeats(s);assert.deepEqual(issues,[]);assert.equal(expanded.components.length,7);assert.equal(new Set(expanded.components.map(c=>c.id)).size,7);const local=expanded.nets.filter(n=>n.id!=='supply');assert.equal(local.length,3);assert.equal(new Set(local.map(n=>n.name)).size,3);assert.ok(local.every(n=>new Set(n.pins.map(p=>p.instance_id.split('_')[1])).size===1));assert.equal(expanded.nets.find(n=>n.id==='supply')?.pins.length,4);assert.equal(expanded.repeat_instances,undefined);assert.equal(expanded.templates,undefined);assert.deepEqual(expandRepeats(expanded).schematic,expanded);
});

test('unknown models, variants, sections, physical pins and duplicate-net membership block generation',async()=>{
 for(const [field,value,code] of [['component_code','UNKNOWN','COMPONENT'],['variant_code','UNKNOWN','VARIANT']] as const){const s=wired();s.components[0][field]=value;assert.ok(validateSchematic(s,lib).some(i=>i.code===code));assert.equal((await buildSchematic(s,lib)).sections.length,0);}
 const missing=wired();missing.nets[0].pins[0].number='999';assert.ok(validateSchematic(missing,lib).some(i=>i.code==='PIN'));
 const badSection=wired();badSection.components[0].sections.UNKNOWN={};assert.ok(validateSchematic(badSection,lib).some(i=>i.code==='SECTION'));
 const duplicate=wired();duplicate.nets.push({id:'other',render:'label',pins:[{instance_id:'left',number:'2'}]});assert.ok(validateSchematic(duplicate,lib).some(i=>i.code==='NET_CONFLICT'));
});

test('hostile primitives, extra pin assignments, nonfinite coordinates and excessive nesting fail validation',()=>{
 const script=structuredClone(resistor) as any;script.variants[0].sections[0].graphics=[{id:'script',kind:'script',text:'alert(1)'}];assert.ok(validateComponent(script).some(i=>i.severity==='error'));
 const assigned=structuredClone(resistor) as any;assigned.physical_pins[0].name='input';assert.ok(validateComponent(assigned).some(i=>i.severity==='error'));
 const invalid=structuredClone(resistor);invalid.variants[0].sections[0].pins[0].x=Infinity;assert.ok(validateComponent(invalid).some(i=>i.severity==='error'));
 const deep=structuredClone(resistor);let p:Primitive={id:'leaf',kind:'line',x:0,y:0,x2:1,y2:1};for(let i=0;i<40;i++)p={id:'g'+i,kind:'group',children:[p]};deep.variants[0].sections[0].graphics=[p];assert.doesNotThrow(()=>validateComponent(deep));assert.ok(validateComponent(deep).some(i=>i.severity==='error'));
});

test('A3 exports are portable outlined SVG or embedded editable text and multisheet ZIP',async()=>{
 const r=await buildSchematic(wired(),lib);assert.deepEqual(errors(r),[]);const outlined=exportSheets(r);assert.equal(outlined.mime,'image/svg+xml');const svg=strFromU8(outlined.bytes);assert.match(svg,/width="420mm" height="297mm" viewBox="0 0 420 297"/);assert.doesNotMatch(svg,/<text\b/);assert.match(svg,/<path\b/);assert.doesNotMatch(svg,/data-section-key|data-pin-number|data-route-id|schematic-section/);assert.doesNotMatch(svg,/<script\b|https?:\/\/(?!www.w3.org)/);
 const editable=strFromU8(exportSheets(r,{textMode:'editable'}).bytes);assert.match(editable,/<text\b/);assert.match(editable,/data:font\/ttf;base64,/);assert.match(editable,/Проверка печати А3/);
 const s=wired();s.sheets.push({id:'sheet_2'});s.components[1].sections.BODY.sheet_id='sheet_2';s.nets[0].render='auto';const m=await buildSchematic(s,lib);assert.deepEqual(errors(m),[]);const exported=exportSheets(m);assert.equal(exported.mime,'application/zip');const files=unzipSync(exported.bytes);assert.deepEqual(Object.keys(files),['sheet_01.svg','sheet_02.svg']);for(const bytes of Object.values(files)){const text=strFromU8(bytes);assert.match(text,/width="420mm"/);assert.doesNotMatch(text,/<text\b/);}
});

test('renderer escapes user text and preserves physical pin numbers without executing markup',async()=>{
 const s=wired();s.document.title='<script>alert("x")</script>';s.components[0].value='<image href="bad"/>';
 const result=await buildSchematic(s,lib);const svg=renderSheet(result,'sheet_1');assert.doesNotMatch(svg,/<script\b|<image\b/);assert.match(svg,/&lt;script&gt;/);assert.match(svg,/&lt;image/);
});

test('existing designators persist and new instances use vacant numbers until explicit renumber',()=>{
 const s=wired();s.components[0].designator='R1';s.components[1].designator='R4';s.components.push({...placed('new',200,60)});assignDesignators(s,lib);assert.deepEqual(s.components.map(c=>c.designator),['R1','R4','R2']);assignDesignators(s,lib,true);assert.deepEqual(s.components.map(c=>c.designator),['R1','R2','R3']);
});

test('group-relative fixed positions are absolute on the page and survive serialization',async()=>{
 const s=emptySchematic();s.groups=[{id:'g',tag:'stage',sheet_id:'sheet_1',position:{x:60,y:50},locked:true}];s.components=[{id:'relative',component_code:'TEST_R',variant_code:'01',tag:'stage',sections:{BODY:{position:{x:10,y:20},relative:true}}}];
 const result=await buildSchematic(s,lib);assert.deepEqual(errors(result),[]);assert.deepEqual(result.sections[0].position,{x:70,y:70});assert.equal(result.schematic.components[0].sections.BODY.locked,true);assert.deepEqual(result.schematic.components[0].sections.BODY.position,{x:10,y:20});const restored=await buildSchematic(JSON.parse(JSON.stringify(result.schematic)),lib);assert.deepEqual(restored.sections[0].position,{x:70,y:70});
});

test('a hard group anchor that conflicts with the title block is diagnosed instead of silently relocated',async()=>{
 const s=emptySchematic();s.groups=[{id:'g',tag:'stage',sheet_id:'sheet_1',position:{x:250,y:250},locked:true}];s.components=[{id:'anchored',component_code:'TEST_R',variant_code:'01',tag:'stage',sections:{BODY:{}}}];
 const result=await buildSchematic(s,lib);assert.ok(result.issues.some(i=>['GROUP_ANCHOR_CONFLICT','OUT_OF_BOUNDS','NO_SPACE'].includes(i.code)),'hard group anchor cannot be silently ignored');
});

test('crossing wire nets remain electrically separate and do not receive a junction dot',async()=>{
 const s=wired();s.components.push(placed('top',107.5,20),placed('bottom',107.5,100));s.components[2].sections.BODY.rotation=90;s.components[3].sections.BODY.rotation=90;s.nets.push({id:'vertical',render:'wire',pins:[{instance_id:'top',number:'2'},{instance_id:'bottom',number:'1'}]});s.layout.routes=[{id:'h',net_id:'signal',sheet_id:'sheet_1',points:[{x:75,y:62.5},{x:135,y:62.5}],locked:true},{id:'v',net_id:'vertical',sheet_id:'sheet_1',points:[{x:105,y:35},{x:105,y:95}],locked:true}];
 const result=await buildSchematic(s,lib);assert.deepEqual(errors(result),[]);assert.equal(result.schematic.nets.length,2);assert.deepEqual(result.schematic.nets,s.nets);assert.ok(!result.issues.some(i=>i.code==='AMBIGUOUS_CROSSING'));assert.doesNotMatch(renderSheet(result,'sheet_1'),/<circle cx="105" cy="62.5"/);
});


test('standalone JSON validators work with string code generation disabled by CSP',()=>{
 const source=readFileSync(new URL('../packages/core/src/generated-validators.ts',import.meta.url),'utf8');
 const script=transformSync(source,{loader:'ts',format:'iife',globalName:'validators',target:'es2022'}).code;
 const context=createContext({}, {codeGeneration:{strings:false,wasm:false}});
 runInContext(script,context,{timeout:1000});
 assert.equal(context.validators.validateComponentJson(resistor),true);
 assert.equal(context.validators.validateComponentJson({...resistor,physical_pins:[{number:'1',name:'forbidden'}]}),false);
 assert.equal(context.validators.validateSchematicJson(wired()),true);
 assert.equal(context.validators.validateSchematicJson({...wired(),format_version:'unknown'}),false);
});

test('manual vertex edits preserve endpoints and orthogonal electrical routes',async()=>{
 const {moveWireVertex,removeWireVertex}=await import('../apps/web/src/wireEditing.js');
 const points=[{x:0,y:0},{x:10,y:0},{x:10,y:20},{x:30,y:20}];
 const moved=moveWireVertex(points,1,{x:15,y:5});
 assert.deepEqual(moved[0],points[0]);assert.deepEqual(moved.at(-1),points.at(-1));
 for(let i=1;i<moved.length;i++)assert.ok(moved[i].x===moved[i-1].x||moved[i].y===moved[i-1].y);
 const removed=removeWireVertex(moved,1);assert.deepEqual(removed[0],points[0]);assert.deepEqual(removed.at(-1),points.at(-1));
 for(let i=1;i<removed.length;i++)assert.ok(removed[i].x===removed[i-1].x||removed[i].y===removed[i-1].y);
});

test('OpenGOST physical uppercase letter height is calibrated to 3.5 mm',async()=>{
 const {parseDrawingFont,DRAWING_FONT_SCALE}=await import('../packages/core/src/font.js');const fs=await import('node:fs');const buffer=fs.readFileSync(new URL('../assets/fonts/OpenGOSTTypeB-Regular.ttf',import.meta.url));const font=parseDrawingFont(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
 const box=font.charToGlyph('Н').getBoundingBox();assert.ok(Math.abs((box.y2-box.y1)/font.unitsPerEm*3.5*DRAWING_FONT_SCALE-3.5)<.001);
 const r=await buildSchematic(wired(),lib);assert.match(renderSheet(r,'sheet_1'),/font-size="5.95"/);
});

test('explicit renumber follows placed page order and single sheet export retains original number',async()=>{
 const {renumberByPosition}=await import('../packages/core/src/layout.js');const s=wired();s.components.reverse();renumberByPosition(s);assignDesignators(s,lib);assert.equal(s.components[0].id,'left');assert.equal(s.components[0].designator,'R1');
 s.sheets.push({id:'sheet_2'});s.components[1].sections.BODY.sheet_id='sheet_2';s.nets[0].render='auto';const result=await buildSchematic(s,lib);const single=exportSheets(result,{sheetId:'sheet_2'});assert.equal(single.name,'sheet_02.svg');assert.equal(single.mime,'image/svg+xml');assert.doesNotMatch(strFromU8(single.bytes),/<text\b/);
});

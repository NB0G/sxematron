import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SheetRoutingCache} from '../apps/server/src/sheet-routing-cache.js';
import {emptySchematic} from '../packages/core/src/layout.js';
import {isRotationLocked,validateComponent,validateSchematic} from '../packages/core/src/validation.js';
import {routingSettings,type ComponentDefinition,type PlacedSection,type Schematic} from '../packages/core/src/types.js';

const lib:ComponentDefinition[]=JSON.parse(readFileSync(new URL('../examples/library.json',import.meta.url),'utf8'));
const resistor=lib.find(c=>c.component_code==='GEN_R')!;
function withComponent(){
 const s=emptySchematic();
 s.components.push({id:'component',component_code:resistor.component_code,variant_code:'01',sections:{BODY:{}}});
 return s;
}
test('project routing controls have defaults and reject unsafe ranges without mutating the input',()=>{
 const s=withComponent();
 assert.deepEqual(routingSettings(s.layout),{iterations:2,bodyClearance:1.25,wireDensity:50});
 assert.equal(s.layout.settings,undefined);
 for(const settings of [{iterations:1,bodyClearance:.5,wireDensity:0},{iterations:8,bodyClearance:5,wireDensity:100}]){
  s.layout.settings=settings;assert.deepEqual(validateSchematic(s,lib),[]);assert.deepEqual(routingSettings(s.layout),settings);
 }
 for(const settings of [{iterations:9},{iterations:0},{iterations:1.5},{wireDensity:101},{bodyClearance:.49}]){
  s.layout.settings=settings;assert.equal(validateSchematic(s,lib)[0].code,'SCHEMA');
 }
});

test('ground belongs to one electrical net, not one name',()=>{
 const s=withComponent();
 s.nets=['1','2'].map(number=>({id:'ground'+number,name:'GND',role:'ground',render:'auto',pins:[{instance_id:'component',number}]}));
 assert.ok(validateSchematic(s,lib).some(e=>e.code==='MULTIPLE_GROUNDS'));
 s.nets[1].role='signal';assert.deepEqual(validateSchematic(s,lib),[]);
});
test('rotation lock is shared between catalogue, UI and validation; two-pin rectangles remain rotatable',()=>{
 const d=structuredClone(resistor),sec=d.variants[0].sections[0],s=withComponent();
 s.components[0].sections.BODY.rotation=270;
 assert.equal(isRotationLocked(d,sec),false);
 d.rotationLocked=true;
 assert.deepEqual(validateComponent(d),[]);
 assert.ok(validateSchematic(s,[d]).some(e=>e.code==='ROTATION_LOCKED'));
 d.rotationLocked=false;
 d.physical_pins.push({number:'3'});sec.pins.push({...sec.pins[0],number:'3',y:sec.pins[0].y+2.5});
 assert.equal(isRotationLocked(d,sec),true);
 assert.ok(validateSchematic(s,[d]).some(e=>e.code==='ROTATION_LOCKED'));
 s.components[0].sections.BODY.rotation=0;
 assert.deepEqual(validateSchematic(s,[d]),[]);
});
test('routing cache includes the effective clearances and wiring preference, not the search budget',()=>{
 const s=withComponent(),cache=new SheetRoutingCache();
 const a:PlacedSection={key:'component/BODY',instance:s.components[0],placement:{},sheet_id:'sheet_1',position:{x:100,y:100},rotation:0,mirror:false,width:10,height:5,section:resistor.variants[0].sections[0]};
 let misses=0;
 const route=(settings?:Schematic['layout']['settings'])=>{
  s.layout.settings=settings;cache.memo(s,[a])('sheet_1',()=>{misses++;return{routes:[],issues:[],labels:[]};});return misses;
 };
 assert.equal(route(),1);
 assert.equal(route({wireDensity:50,iterations:8}),1);
 assert.equal(route({bodyClearance:3}),2);
 assert.equal(route({bodyClearance:3,wireDensity:90}),3);
 assert.equal(route({bodyClearance:3,wireDensity:90,iterations:1}),3);
});
test('manual point-to-point label anchors must refer to an existing peer sheet',()=>{
 const s=withComponent();s.nets=[{id:'n',render:'auto',pins:[{instance_id:'component',number:'1'}]}];
 s.layout.labels=[{net_id:'n',instance_id:'component',number:'1',position:{x:100,y:100},peerSheet:'missing'}];
 assert.ok(validateSchematic(s,lib).some(e=>e.code==='SHEET'));s.sheets.push({id:'missing'});assert.deepEqual(validateSchematic(s,lib),[]);
});

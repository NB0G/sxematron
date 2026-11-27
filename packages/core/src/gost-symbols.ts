import type {ComponentDefinition,Primitive} from './types.js';

// ГОСТ 2.728-74, table 6, positions 1 and 9; drawing dimensions in mm.
// The legacy templates are matched exactly, including their terminal geometry.
// Captions, component codes and connection coordinates are never rescaled.
const specs:Record<string,{before:Omit<Primitive,'id'>[];after:Omit<Primitive,'id'>[]}> = {
 GEN_R:{
  before:[{kind:'rectangle',x:0,y:0,width:10,height:5}],
  after:[{kind:'rectangle',x:0,y:.5,width:10,height:4}],
 },
 GEN_C:{
  before:[{kind:'line',x:4,y:-1,x2:4,y2:6},{kind:'line',x:6,y:-1,x2:6,y2:6},{kind:'line',x:0,y:2.5,x2:4,y2:2.5},{kind:'line',x:6,y:2.5,x2:10,y2:2.5}],
  after:[{kind:'line',x:4.25,y:-1.5,x2:4.25,y2:6.5},{kind:'line',x:5.75,y:-1.5,x2:5.75,y2:6.5},{kind:'line',x:0,y:2.5,x2:4.25,y2:2.5},{kind:'line',x:5.75,y:2.5,x2:10,y2:2.5}],
 },
};

export function standardBuiltInSymbol(def:ComponentDefinition):ComponentDefinition{
 if(!Object.hasOwn(specs,def.component_code)||def.variants.length!==1)return def;
 const {before,after}=specs[def.component_code],variant=def.variants[0],section=variant.sections[0];
 if(variant.variant_code!=='01'||variant.sections.length!==1||section?.section_id!=='BODY'||section.pins.length!==2||section.graphics.length!==before.length)return def;
 if(!section.pins.every((p,i)=>p.number===String(i+1)&&p.x===(i?15:-5)&&p.y===2.5&&p.side===(i?'right':'left')&&(p.length??5)===5))return def;
 const match=section.graphics.every(({id:_,...p},i)=>{
  const expected=before[i];
  return Object.keys(p).length===Object.keys(expected).length&&Object.entries(expected).every(([k,v])=>p[k as keyof typeof p]===v);
 });
 if(!match)return def;
 const graphics=section.graphics.map((p,i)=>({...after[i],id:p.id}));
 return {...def,variants:[{...variant,sections:[{...section,graphics}]}]};
}

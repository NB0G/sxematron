import type {ComponentDefinition,Instance,Library,PlacedSection,Resolved,Schematic,Issue,Placement} from './types.js';
import {expandRepeats,isRotationLocked,validateSchematic} from './validation.js';
import {PAGE,placedBounds,sectionBounds,intersects,round,pinPosition,pinDirection,printedSectionParts,segmentHitsBounds,type Bounds} from './geometry.js';
import {standardBuiltInSymbol} from './gost-symbols.js';
import {MAX_SCHEMATIC_SHEETS} from './schemas.js';
import {chooseAutoShape,compactOrigins,pinNets,placementGroups,localEdges,type LayoutElk} from './auto-placement.js';
import {finishDrawing,refineDrawing} from './optimization.js';
import {labelBounds,routeSchematic,type RoutedSheets} from './routing.js';
export type LayoutOptions={reset?:boolean;reflow?:boolean};
async function createElk():Promise<LayoutElk>{
 const {default:Elk}=await import('elkjs/lib/elk.bundled.js');
 return new (Elk as unknown as {new():LayoutElk})();
}
export function fingerprint(c:ComponentDefinition){let h=2166136261;const str=JSON.stringify(c);for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(16);}
export function assignDesignators(s:Schematic,lib:Library,reset=false){const used=new Set(reset?[]:s.components.map(c=>c.designator).filter(Boolean));for(const c of s.components){if(reset)delete c.designator;if(c.designator)continue;const prefix=lib.find(d=>d.component_code===c.component_code)?.positional_prefix??'X';let i=1;while(used.has(prefix+i))i++;c.designator=prefix+i;used.add(c.designator);}}
/** Explicit user action only: sheet order, then top-to-bottom and left-to-right. */
export function renumberByPosition(s:Schematic){const anchor=(c:Instance)=>Object.values(c.sections).filter(p=>p.position).map(p=>({sheet:Math.max(0,s.sheets.findIndex(sh=>sh.id===p.sheet_id)),x:p.position!.x,y:p.position!.y})).sort((a,b)=>a.sheet-b.sheet||a.y-b.y||a.x-b.x)[0]??{sheet:1e6,x:1e6,y:1e6};s.components.sort((a,b)=>{const x=anchor(a),y=anchor(b);return x.sheet-y.sheet||x.y-y.y||x.x-y.x;});for(const c of s.components)delete c.designator;}
export function emptySchematic():Schematic{return{format_version:'1.0',document:{title:'Схема электрическая принципиальная',designation:''},sheets:[{id:'sheet_1'}],groups:[],components:[],nets:[],layout:{mode:'mixed',unit:'mm',routes:[],labels:[]}};}
let sequence=0;export function newId(prefix='id'){return `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`;}
export async function buildSchematic(input:Schematic,lib:Library,options:LayoutOptions={},route:(s:Schematic,sections:PlacedSection[])=>RoutedSheets|Promise<RoutedSheets>=routeSchematic):Promise<Resolved>{
 lib=lib.map(standardBuiltInSymbol);
 const issues=validateSchematic(input,lib);if(issues.some(i=>i.severity==='error'))return{schematic:structuredClone(input),sections:[],routes:[],labels:[],issues};
 const expanded=expandRepeats(input),s=expanded.schematic;issues.push(...expanded.issues);assignDesignators(s,lib);
 if(options.reset){for(const c of s.components)for(const p of Object.values(c.sections)){delete p.position;delete p.locked;if(p.autoRotation){delete p.rotation;delete p.autoRotation;}}s.layout.routes=[];s.layout.labels=[];}
 const reflowAnchors=new Set<Placement>();
 if(options.reflow&&!options.reset){
  const lockedNets=new Set(s.layout.routes.filter(r=>r.locked).map(r=>r.net_id));
  const anchored=new Set([...s.nets.filter(n=>lockedNets.has(n.id)).flatMap(n=>n.pins.map(p=>p.instance_id)),...(s.layout.labels??[]).map(l=>l.instance_id)]);
  const fixedGroups=new Set(s.groups.filter(g=>g.locked&&g.position).map(g=>g.tag));
  for(const c of s.components)for(const p of Object.values(c.sections)){
   if(anchored.has(c.id)||c.tag&&fixedGroups.has(c.tag)){if(p.position)reflowAnchors.add(p);}
   else if(!p.locked){
    delete p.position;
    if(p.autoRotation){delete p.rotation;delete p.autoRotation;}
   }
  }
 }
 const byPin=pinNets(s.nets);
 // Size the reserved side corridor using the very font used for output.
 // A net crossing sheets needs just one peer address, not every page number.
 const groupSheets=new Map(s.groups.map(g=>[g.tag,g.sheet_id]));
 const where=new Map<string,string>();
 for(const c of s.components){
  const variant=lib.find(d=>d.component_code===c.component_code)?.variants.find(v=>v.variant_code===c.variant_code);
  for(const sec of variant?.sections??[]){const sh=c.sections[sec.section_id]?.sheet_id??groupSheets.get(c.tag??'');if(sh)for(const p of sec.pins)where.set(c.id+'\0'+p.number,sh);}
 }
 const pageCount=new Map(s.nets.map(n=>[n,new Set(n.pins.map(p=>where.get(p.instance_id+'\0'+p.number)).filter(Boolean)).size]));
 const widths=new Map<string,number>();
 function labelExtent(net:Schematic['nets'][number]){
  if(net.role==='ground')return 8;
  const inter=(pageCount.get(net)??0)>1;
  if(!inter&&net.render==='auto'&&net.pins.length>1&&net.pins.length<=8)return 8;
  const text=(net.name||net.id)+(inter?' (л.'+s.sheets.length+')':'');
  let width=widths.get(text);if(width===undefined){const b=labelBounds(text,{x:0,y:0},false);width=Math.min(17,Math.max(9,b.right*.4+4));widths.set(text,width);}
  return width;
 }
 const sections:PlacedSection[]=[];
 for(const c of s.components){const d=lib.find(d=>d.component_code===c.component_code)!;const f=fingerprint(d);if(c.definition_fingerprint&&c.definition_fingerprint!==f)issues.push({severity:'warning',code:'DEFINITION_CHANGED',message:`${c.designator}: библиотечное определение изменено; используется текущее`});c.definition_fingerprint=f;const v=d.variants.find(v=>v.variant_code===c.variant_code)!;for(const section of v.sections){const p=c.sections[section.section_id]??{};c.sections[section.section_id]=p;const group=s.groups.find(g=>g.tag===c.tag);if(group?.locked&&group.position&&p.position)p.locked=true;const pos=p.position?{x:p.position.x+(p.relative?(group?.position?.x??0):0),y:p.position.y+(p.relative?(group?.position?.y??0):0)}:{x:0,y:0};const label_padding:Partial<Record<'left'|'right'|'top'|'bottom',number>>={};for(const pin of section.pins){const net=byPin.get(c.id+'\0'+pin.number);if(!net||net.render==='wire'&&net.pins.length>1)continue;const extent=labelExtent(net);if(pin.side==='left'||pin.side==='right')label_padding[pin.side]=Math.max(label_padding[pin.side]??0,extent);else{label_padding[pin.side]=Math.max(label_padding[pin.side]??0,net.role==='ground'?9:12);}}const b=sectionBounds(section,p.rotation,p.mirror,{...c,label_padding});sections.push({label_padding,key:`${c.id}/${section.section_id}`,instance:c,section,placement:p,sheet_id:p.sheet_id??group?.sheet_id??'',position:pos,rotation:p.rotation??0,mirror:p.mirror??false,width:b.right-b.x,height:b.bottom-b.y});}}
 // Never move an imported position, manual wire endpoint or explicit label
 // anchor during feedback. Reflow above deliberately releases only soft poses.
 const handNets=new Set(s.layout.routes.filter(r=>r.locked).map(r=>r.net_id));
 const anchoredIds=new Set([...s.nets.filter(n=>handNets.has(n.id)).flatMap(n=>n.pins.map(p=>p.instance_id)),...(s.layout.labels??[]).map(l=>l.instance_id)]);
 const fixedTags=new Set(s.groups.filter(g=>g.locked).map(g=>g.tag));
 const movable=new Set(sections.filter(a=>!a.placement.position&&!a.placement.locked&&!anchoredIds.has(a.instance.id)&&!fixedTags.has(a.instance.tag??'')).map(a=>a.key));
 const turnable=new Set(sections.filter(a=>a.placement.rotation===undefined&&!isRotationLocked(lib.find(d=>d.component_code===a.instance.component_code)!,a.section)).map(a=>a.key));
 const assigned=sections.filter(a=>(a.placement.locked||reflowAnchors.has(a.placement))&&a.placement.position);for(const a of assigned)if(!a.sheet_id)a.sheet_id=s.sheets[0].id;
 const unplaced=sections.filter(a=>!assigned.includes(a)),groups=placementGroups(unplaced,s.nets);
 let elk:Promise<LayoutElk>|undefined;
 const getElk=()=>elk??=createElk();
 const coarse=compactOrigins(5,350,250),fine=compactOrigins(5,395,265);
 const stamp={x:PAGE.stamp.x-4,y:PAGE.stamp.y-4,right:PAGE.stamp.x+PAGE.stamp.width,bottom:PAGE.stamp.y+PAGE.stamp.height};
 const sheetIds=new Set(s.sheets.map(sheet=>sheet.id));let nextSheet=s.sheets.length+1;
 const localBounds=new WeakMap<PlacedSection,ReturnType<typeof placedBounds>>(),obstacleBounds=new WeakMap<PlacedSection,ReturnType<typeof placedBounds>>();
 function boundsAt(a:PlacedSection,pos:{x:number;y:number}){let b=localBounds.get(a);if(!b){b=placedBounds({...a,position:{x:0,y:0}},2.5);localBounds.set(a,b);}return{x:b.x+pos.x,y:b.y+pos.y,right:b.right+pos.x,bottom:b.bottom+pos.y};}
 const lockedOnSheet=new Map<string,Schematic['layout']['routes']>();
 for(const wire of s.layout.routes)if(wire.locked){
  const others=lockedOnSheet.get(wire.sheet_id)??[];
  others.push(wire);lockedOnSheet.set(wire.sheet_id,others);
 }
 const edgeRoom=new WeakMap<PlacedSection,Bounds>();
 function marginFromFrame(a:PlacedSection){
  const previous=edgeRoom.get(a);if(previous)return previous;
  const box={x:Infinity,y:Infinity,right:-Infinity,bottom:-Infinity};
  const sides=new Map<string,{x:number;y:number;width:number;dx:number;dy:number}[]>();
  const zero={...a,position:{x:0,y:0}};
  for(const pin of a.section.pins){
   const net=byPin.get(a.instance.id+'\0'+pin.number);
   if(!net||net.role==='ground'||net.render==='wire'&&net.pins.length>1&&(pageCount.get(net)??0)<=1)continue;
   const {x,y}=pinPosition(zero,pin),{x:dx,y:dy}=pinDirection(zero,pin),side=JSON.stringify([dx,dy]);
   const text=(net.name||net.id)+((pageCount.get(net)??0)>1?` (л.${s.sheets.length})`:'');
   const b=labelBounds(text,{x:0,y:0},false),list=sides.get(side)??[];
   list.push({x,y,width:b.right-b.x,dx,dy});sides.set(side,list);
  }
  for(const list of sides.values())if(list.length>=2)for(const {x,y,width,dx,dy} of list){
   const gap=Math.min(59,width+7);
   if(dx<0)box.x=Math.min(box.x,x-gap);
   if(dx>0)box.right=Math.max(box.right,x+gap);
   if(dy<0)box.y=Math.min(box.y,y-11);
   if(dy>0)box.bottom=Math.max(box.bottom,y+8);
  }
  edgeRoom.set(a,box);return box;
 }
 function free(a:PlacedSection,sheet:string,pos:{x:number;y:number},reserve=true){
  const b=boundsAt(a,pos);
  if(reserve&&!a.placement.position){
   const room=marginFromFrame(a);
   if(room.x+pos.x<22||room.right+pos.x>413||room.y+pos.y<7||room.bottom+pos.y>290)return false;
  }
  const manual=lockedOnSheet.get(sheet);
  if(manual&&!anchoredIds.has(a.instance.id)){
   const ink=printedSectionParts({...a,position:pos});
   if(manual.some(w=>w.points.slice(1).some((p,i)=>ink.some(box=>segmentHitsBounds(w.points[i],p,box)))))return false;
  }
  return b.x>=PAGE.drawing.x&&b.y>=PAGE.drawing.y&&b.right<=PAGE.drawing.right&&b.bottom<=PAGE.drawing.bottom&&!intersects(b,stamp)&&!assigned.some(other=>{
   if(other.sheet_id!==sheet)return false;
   let box=obstacleBounds.get(other);
   if(!box){box=boundsAt(other,other.position);obstacleBounds.set(other,box);}
   return intersects(b,box);
  });
 }
 for(const rawList of groups){
 // Valid soft positions are retained first; invalid hints remain eligible for relocation.
 const list=rawList.filter(a=>{if(a.placement.position&&free(a,a.sheet_id||s.sheets[0].id,a.position)){a.sheet_id||=s.sheets[0].id;assigned.push(a);return false;}return true;});if(!list.length)continue;
 const edges=localEdges(list,s.nets);
 const group=s.groups.find(g=>g.tag===list[0].instance.tag),target=list[0].sheet_id;
 const {shape,elkFailed}=await chooseAutoShape(list,edges,byPin,turnable,getElk,!!(group?.locked&&group.position));
 if(elkFailed)issues.push({severity:'warning',code:'LAYOUT_FALLBACK',message:'ELK не смог построить один из вариантов; использован доступный вариант раскладки'});
 const {offsets,rotations}=shape;
 list.forEach((a,i)=>{
  if(a.rotation===rotations[i])return;
  a.rotation=rotations[i];localBounds.delete(a);edgeRoom.delete(a);
  const b=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});
  a.width=b.right-b.x;a.height=b.bottom-b.y;
 });
 const candidates=target?[target]:s.sheets.map(sh=>sh.id);let fitted=false;
 // Look at a few valid translations, favoring short links to components
 // already placed. Hard anchors and retained position hints are never moved.
 const links:{index:number;x:number;y:number;to:{x:number;y:number};sheet:string;owner:string}[]=[];
 if(!group?.locked&&assigned.length){
  const own=new Map(list.flatMap((a,index)=>a.section.pins.map(pin=>[`${a.instance.id}\0${pin.number}`,{index,...pinPosition({...a,position:{x:0,y:0}},pin)}] as const)));
  const neighbors=new Map(assigned.flatMap(a=>a.section.pins.map(pin=>[`${a.instance.id}\0${pin.number}`,{sheet:a.sheet_id,to:pinPosition(a,pin),owner:a.key}] as const)));
  for(const net of s.nets){
   if(net.role&&net.role!=='signal'||net.pins.length>16)continue;
   const keys=net.pins.map(pin=>`${pin.instance_id}\0${pin.number}` as const);
   const connected=keys.flatMap(key=>neighbors.get(key)??[]);
   for(const key of keys){const terminal=own.get(key);if(terminal)for(const neighbor of connected)links.push({...terminal,...neighbor});}
  }
 }
 const between=(value:number,a:number,b:number)=>Math.min(a,b)<value&&value<Math.max(a,b);
 function legHits(a:{x:number;y:number},b:{x:number;y:number},box:ReturnType<typeof placedBounds>){
  return a.x===b.x?between(a.x,box.x,box.right)&&Math.max(a.y,b.y)>box.y&&Math.min(a.y,b.y)<box.bottom:
   between(a.y,box.y,box.bottom)&&Math.max(a.x,b.x)>box.x&&Math.min(a.x,b.x)<box.right;
 }
 let winner:{sheet:string;poses:{x:number;y:number}[];score:number}|undefined;
 for(const sheet of candidates){
  const hint=group?.position;const origins=hint?[hint]:[];
  for(const link of links.filter(l=>l.sheet===sheet).slice(0,4)){
   const o=offsets[link.index],x=link.to.x-o.x-link.x,y=link.to.y-o.y-link.y;
   for(const [dx,dy] of [[-18,0],[18,0],[0,-18],[0,18],[-26,0],[26,0],[0,-26],[0,26]])origins.push({x:x+dx,y:y+dy});
  }
  origins.push(...coarse);
  const obstacles=links.some(l=>l.sheet===sheet)?assigned.filter(a=>a.sheet_id===sheet).map(a=>({key:a.key,box:boundsAt(a,a.position)})):[];
  let scanned=0;
  for(const origin of origins){
   const poses=offsets.map(offset=>({x:round(origin.x+offset.x),y:round(origin.y+offset.y)}));
   if(list.every((a,i)=>free(a,sheet,poses[i]))){
    const score=links.reduce((n,l)=>{
     if(l.sheet!==sheet)return n+PAGE.width;
     const from={x:poses[l.index].x+l.x,y:poses[l.index].y+l.y},to=l.to;
     const crossings=(corner:{x:number;y:number})=>obstacles.filter(o=>o.key!==l.owner&&(legHits(from,corner,o.box)||legHits(corner,to,o.box))).length;
     const blocked=Math.min(crossings({x:from.x,y:to.y}),crossings({x:to.x,y:from.y}));
     return n+Math.abs(from.x-to.x)+Math.abs(from.y-to.y)+12*blocked;
    },0);
    if(!winner||score<winner.score)winner={sheet,poses,score};
    if(++scanned>=(links.length?8:1))break;
   }
   if(group?.locked&&hint)break;
  }
  if(winner&&!links.length)break;
 }
 if(winner){const {sheet,poses}=winner;list.forEach((a,i)=>{a.position=poses[i];a.sheet_id=sheet;assigned.push(a);});fitted=true;}

 if(fitted)continue;
 if(group?.locked&&group.position){const sheet=target||s.sheets[0].id;for(const [i,a] of list.entries()){a.position={x:round(group.position.x+offsets[i].x),y:round(group.position.y+offsets[i].y)};a.sheet_id=sheet;a.placement.locked=true;assigned.push(a);}issues.push({severity:'warning',code:'GROUP_ANCHOR_CONFLICT',message:`Группа ${group.id}: жёсткая позиция сохранена, но группа пересекает препятствия или границы листа`});continue;}
 const remaining=new Set(list);
 const edgesToPlace=localEdges([...list,...assigned.filter(a=>!target||a.sheet_id===target)],s.nets);
 while(remaining.size){
  function priority(a:PlacedSection){
   let score=0;
   for(const edge of edgesToPlace){
    if(edge.from!==a&&edge.to!==a)continue;
    const peer=edge.from===a?edge.to:edge.from;
    score+=(edge.weight??1)*(assigned.includes(peer)?12:2);
   }
   return score;
  }
  const a=[...remaining].sort((a,b)=>priority(b)-priority(a)||a.key.localeCompare(b.key))[0];
  remaining.delete(a);
  let done=false;
  if(a.placement.position){
   const sh=target||s.sheets[0].id;
   if(free(a,sh,a.position)){a.sheet_id=sh;assigned.push(a);continue;}
  }
  const choices=target?[target]:s.sheets.map(sh=>sh.id);
  function fitOn(sheet:string,reserve=true){
   const neighbors=assigned.filter(section=>section.sheet_id===sheet);
   const related=localEdges([a,...neighbors],s.nets).filter(edge=>edge.from===a||edge.to===a);
   const rotations=turnable.has(a.key)?[...new Set([a.rotation,0,90,180,270])]:[a.rotation];
   const previous=a.rotation;
   for(const rotation of rotations){
    a.rotation=rotation;
    localBounds.delete(a);edgeRoom.delete(a);
    const b=boundsAt(a,{x:0,y:0}),points:{x:number;y:number}[]=[];
    const connections=related.map(edge=>{
     const pin=edge.from===a?edge.pinFrom:edge.pinTo;
     const peer=edge.from===a?edge.to:edge.from,other=edge.from===a?edge.pinTo:edge.pinFrom;
     const p=pinPosition(peer,other),q=pinPosition({...a,position:{x:0,y:0}},pin),out=pinDirection(peer,other);
     return {p,q,out,weight:edge.weight??1};
    });
    for(const {p,q,out} of connections)for(const gap of [16,23,32,45])for(const shift of [0,10,-10,20,-20,32,-32]){
     points.push({x:p.x+out.x*gap-q.x-out.y*shift,y:p.y+out.y*gap-q.y+out.x*shift});
    }
    const span=(point:{x:number;y:number})=>connections.reduce((score,{p,q,weight})=>{
     const dx=p.x-q.x-point.x,dy=p.y-q.y-point.y;
     return score+weight*(Math.abs(dx)+Math.abs(dy)+8*Number(dx!==0&&dy!==0));
    },0);
    points.sort((a,b)=>span(a)-span(b));
    for(const pos of [...points,...fine.map(({x,y})=>({x:x-b.x,y:y-b.y}))]){
     const p={x:round(pos.x),y:round(pos.y)};
     if(!free(a,sheet,p,reserve))continue;
     a.position=p;a.sheet_id=sheet;
     const box=sectionBounds(a.section,rotation,a.mirror,{...a.instance,label_padding:a.label_padding});
     a.width=box.right-box.x;a.height=box.bottom-box.y;
     assigned.push(a);return true;
    }
   }
   a.rotation=previous;localBounds.delete(a);edgeRoom.delete(a);
   return false;
  }
  done=choices.some(sheet=>fitOn(sheet));
  if(!done&&a.label_padding){
   a.label_padding=undefined;localBounds.delete(a);
   done=choices.some(sheet=>fitOn(sheet,false));
  }
  if(!done&&!target&&s.sheets.length<MAX_SCHEMATIC_SHEETS){
   while(sheetIds.has(`sheet_auto_${nextSheet}`))nextSheet++;
   const id=`sheet_auto_${nextSheet}`;
   if(fitOn(id)){s.sheets.push({id});sheetIds.add(id);nextSheet++;done=true;}
  }
  if(!done)issues.push({severity:'error',code:'NO_SPACE',sheet_id:target||undefined,obstacle:a.key,message:`${a.instance.designator}/${a.section.section_id}: нет места на заданном листе`});
 }
 }
 const placed=sections.filter(a=>assigned.includes(a));
 for(const a of placed){const group=s.groups.find(g=>g.tag===a.instance.tag);const p=a.placement;p.sheet_id=a.sheet_id;if(a.rotation!==(p.rotation??0)){p.rotation=a.rotation;p.autoRotation=true;}if(p.relative&&group?.position)p.position={x:round(a.position.x-group.position.x),y:round(a.position.y-group.position.y)};else{p.position={...a.position};delete p.relative;}}
 const routed=await route(s,placed);
 return refineDrawing(finishDrawing(s,placed,issues,routed),routed,issues,movable,turnable);
}

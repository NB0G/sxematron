import type {ComponentDefinition,Instance,Library,PlacedSection,Resolved,Schematic,Issue,Placement} from './types.js';
import {expandRepeats,validateSchematic} from './validation.js';
import {PAGE,placedBounds,sectionBounds,intersects,round,pinPosition} from './geometry.js';
import {MAX_SCHEMATIC_SHEETS} from './schemas.js';
import {chooseAutoShape,compactOrigins,pinNets,placementGroups,type AutoEdge,type LayoutElk} from './auto-placement.js';
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
 const issues=validateSchematic(input,lib);if(issues.some(i=>i.severity==='error'))return{schematic:structuredClone(input),sections:[],routes:[],labels:[],issues};
 const expanded=expandRepeats(input),s=expanded.schematic;issues.push(...expanded.issues);assignDesignators(s,lib);
 if(options.reset){for(const c of s.components)for(const p of Object.values(c.sections)){delete p.position;delete p.locked;}s.layout.routes=[];s.layout.labels=[];}
 const reflowAnchors=new Set<Placement>();
 if(options.reflow&&!options.reset){
  const lockedNets=new Set(s.layout.routes.filter(r=>r.locked).map(r=>r.net_id));
  const anchored=new Set(s.nets.filter(n=>lockedNets.has(n.id)).flatMap(n=>n.pins.map(p=>p.instance_id)));
  const fixedGroups=new Set(s.groups.filter(g=>g.locked&&g.position).map(g=>g.tag));
  for(const c of s.components)for(const p of Object.values(c.sections)){
   if(anchored.has(c.id)||c.tag&&fixedGroups.has(c.tag)){if(p.position)reflowAnchors.add(p);}
   else if(!p.locked)delete p.position;
  }
 }
 const byPin=pinNets(s.nets),passives=new Set(lib.filter(c=>/^[RРCС]$/.test(c.positional_prefix)).map(c=>c.component_code));
 const sections:PlacedSection[]=[];
 for(const c of s.components){const d=lib.find(d=>d.component_code===c.component_code)!;const f=fingerprint(d);if(c.definition_fingerprint&&c.definition_fingerprint!==f)issues.push({severity:'warning',code:'DEFINITION_CHANGED',message:`${c.designator}: библиотечное определение изменено; используется текущее`});c.definition_fingerprint=f;const v=d.variants.find(v=>v.variant_code===c.variant_code)!;for(const section of v.sections){const p=c.sections[section.section_id]??{};c.sections[section.section_id]=p;const group=s.groups.find(g=>g.tag===c.tag);if(group?.locked&&group.position&&p.position)p.locked=true;const pos=p.position?{x:p.position.x+(p.relative?(group?.position?.x??0):0),y:p.position.y+(p.relative?(group?.position?.y??0):0)}:{x:0,y:0};const label_padding:Partial<Record<'left'|'right'|'top'|'bottom',number>>={};for(const pin of section.pins){const net=byPin.get(c.id+'\0'+pin.number);if(!net||net.render==='wire'&&net.pins.length>1)continue;const extent=net.role==='ground'?10:Math.min(25,(net.name||net.id).length*1.45+7);if(pin.side==='left'||pin.side==='right')label_padding[pin.side]=Math.max(label_padding[pin.side]??0,extent);else{label_padding[pin.side]=11;label_padding.right=Math.max(label_padding.right??0,extent);}}const b=sectionBounds(section,p.rotation,p.mirror,{...c,label_padding});sections.push({label_padding,key:`${c.id}/${section.section_id}`,instance:c,section,placement:p,sheet_id:p.sheet_id??group?.sheet_id??'',position:pos,rotation:p.rotation??0,mirror:p.mirror??false,width:b.right-b.x,height:b.bottom-b.y});}}
 const assigned=sections.filter(a=>(a.placement.locked||reflowAnchors.has(a.placement))&&a.placement.position);for(const a of assigned)if(!a.sheet_id)a.sheet_id=s.sheets[0].id;
 const unplaced=sections.filter(a=>!assigned.includes(a)),groups=placementGroups(unplaced,s.nets);
 let elk:Promise<LayoutElk>|undefined;
 const getElk=()=>elk??=createElk();
 const coarse=compactOrigins(5,350,250),fine=compactOrigins(5,395,265);
 const stamp={x:PAGE.stamp.x-4,y:PAGE.stamp.y-4,right:PAGE.stamp.x+PAGE.stamp.width,bottom:PAGE.stamp.y+PAGE.stamp.height};
 const sheetIds=new Set(s.sheets.map(sheet=>sheet.id));let nextSheet=s.sheets.length+1;
 const localBounds=new WeakMap<PlacedSection,ReturnType<typeof placedBounds>>(),obstacleBounds=new WeakMap<PlacedSection,ReturnType<typeof placedBounds>>();
 function boundsAt(a:PlacedSection,pos:{x:number;y:number}){let b=localBounds.get(a);if(!b){b=placedBounds({...a,position:{x:0,y:0}},2.5);localBounds.set(a,b);}return{x:b.x+pos.x,y:b.y+pos.y,right:b.right+pos.x,bottom:b.bottom+pos.y};}
 function free(a:PlacedSection,sheet:string,pos:{x:number;y:number}){const b=boundsAt(a,pos);return b.x>=PAGE.drawing.x&&b.y>=PAGE.drawing.y&&b.right<=PAGE.drawing.right&&b.bottom<=PAGE.drawing.bottom&&!intersects(b,stamp)&&!assigned.some(other=>{if(other.sheet_id!==sheet)return false;let box=obstacleBounds.get(other);if(!box){box=boundsAt(other,other.position);obstacleBounds.set(other,box);}return intersects(b,box);});}
 for(const rawList of groups){
 // Valid soft positions are retained first; invalid hints remain eligible for relocation.
 const list=rawList.filter(a=>{if(a.placement.position&&free(a,a.sheet_id||s.sheets[0].id,a.position)){a.sheet_id||=s.sheets[0].id;assigned.push(a);return false;}return true;});if(!list.length)continue;
 const inGroup=new Map(list.flatMap(a=>a.section.pins.map(pin=>[a.instance.id+'\0'+pin.number,{a,pin}] as const)));
 const edges:AutoEdge[]=[];
 for(const net of s.nets){
  if(net.render==='label'||net.role&&net.role!=='signal')continue;
  const ends=net.pins.flatMap(p=>inGroup.get(p.instance_id+'\0'+p.number)??[]);
  for(let i=1;i<ends.length;i++){
   let a=ends[i-1],b=ends[i];if(a.a===b.a)continue;
   if(a.pin.side==='left'&&b.pin.side==='right')[a,b]=[b,a];
   edges.push({from:a.a,to:b.a,pinFrom:a.pin,pinTo:b.pin});
  }
 }
 const group=s.groups.find(g=>g.tag===list[0].instance.tag),target=list[0].sheet_id;
 const {shape,elkFailed}=await chooseAutoShape(list,edges,byPin,passives,getElk,!!(group?.locked&&group.position));
 if(elkFailed)issues.push({severity:'warning',code:'LAYOUT_FALLBACK',message:'ELK не смог построить один из вариантов; использован доступный вариант раскладки'});
 const {offsets,rotations}=shape;
 list.forEach((a,i)=>{
  if(a.rotation===rotations[i])return;
  a.rotation=rotations[i];localBounds.delete(a);
  const b=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});
  a.width=b.right-b.x;a.height=b.bottom-b.y;
 });
 const candidates=target?[target]:s.sheets.map(sh=>sh.id);let fitted=false;
 // Look at a few valid translations, favoring short links to components
 // already placed. Hard anchors and retained position hints are never moved.
 const links:{index:number;x:number;y:number;to:{x:number;y:number};sheet:string;owner:string}[]=[];
 if(!group?.locked&&assigned.length&&s.components.length<=200){
  const own=new Map(list.flatMap((a,index)=>a.section.pins.map(pin=>[`${a.instance.id}\0${pin.number}`,{index,...pinPosition({...a,position:{x:0,y:0}},pin)}] as const)));
  const neighbors=new Map(assigned.flatMap(a=>a.section.pins.map(pin=>[`${a.instance.id}\0${pin.number}`,{sheet:a.sheet_id,to:pinPosition(a,pin),owner:a.key}] as const)));
  for(const net of s.nets){
   const keys=net.pins.map(pin=>`${pin.instance_id}\0${pin.number}` as const);
   const connected=keys.flatMap(key=>neighbors.get(key)??[]);
   for(const key of keys){const terminal=own.get(key);if(terminal)for(const neighbor of connected.slice(0,4))if(links.length<48)links.push({...terminal,...neighbor});}
   if(links.length>=48)break;
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
 for(const a of list){let done=false;const preferred=a.placement.position;if(preferred){const pos=a.position;const sh=target||s.sheets[0].id;if(free(a,sh,pos)){a.sheet_id=sh;assigned.push(a);continue;}}
 const b=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});
 function fitOn(sheet:string){for(const {x,y} of fine){const pos={x:round(x-b.x),y:round(y-b.y)};if(free(a,sheet,pos)){a.position=pos;a.sheet_id=sheet;assigned.push(a);return true;}}return false;}
 done=(target?[target]:s.sheets.map(sh=>sh.id)).some(fitOn);
 if(!done&&!target&&s.sheets.length<MAX_SCHEMATIC_SHEETS){
  while(sheetIds.has(`sheet_auto_${nextSheet}`))nextSheet++;
  const id=`sheet_auto_${nextSheet}`;
  if(fitOn(id)){s.sheets.push({id});sheetIds.add(id);nextSheet++;done=true;}
 }
 if(!done){a.sheet_id=target||s.sheets[0].id;const b=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});a.position={x:PAGE.drawing.x-b.x,y:PAGE.drawing.y-b.y};assigned.push(a);issues.push({severity:'error',code:'NO_SPACE',message:`${a.instance.designator}/${a.section.section_id}: нет места на заданном листе`});}}
 }
 const physical=new Map(sections.map(a=>[a,placedBounds({...a,label_padding:undefined})]));
 for(const a of sections){const group=s.groups.find(g=>g.tag===a.instance.tag);const p=a.placement;p.sheet_id=a.sheet_id;if(a.rotation!==(p.rotation??0))p.rotation=a.rotation;if(p.relative&&group?.position)p.position={x:round(a.position.x-group.position.x),y:round(a.position.y-group.position.y)};else{p.position={...a.position};delete p.relative;}const b=physical.get(a)!;if(b.x<PAGE.drawing.x||b.y<PAGE.drawing.y||b.right>PAGE.drawing.right||b.bottom>PAGE.drawing.bottom||intersects(b,stamp))issues.push({severity:'warning',code:'OUT_OF_BOUNDS',message:`${a.instance.designator}/${a.section.section_id}: выходит за рабочее поле или заходит на штамп`});}
 for(let i=0;i<sections.length;i++)for(let j=i+1;j<sections.length;j++)if(sections[i].sheet_id===sections[j].sheet_id&&intersects(physical.get(sections[i])!,physical.get(sections[j])!))issues.push({severity:'warning',code:'OVERLAP',message:`Наложение ${sections[i].instance.designator}/${sections[i].section.section_id} и ${sections[j].instance.designator}/${sections[j].section.section_id}`});
 const routed=await route(s,sections);issues.push(...routed.issues);
 const labelBoxes=routed.labels.map(label=>{const a=sections.find(a=>a.instance.id===label.pin?.instance_id&&a.section.pins.some(p=>p.number===label.pin?.number));return{label,owner:a,box:labelBounds(label.text,label.point,label.alignLeft??false)};});
 for(let i=0;i<labelBoxes.length;i++){const a=labelBoxes[i];if(a.box.x<20||a.box.right>415||a.box.y<5||a.box.bottom>292)issues.push({severity:'warning',code:'LABEL_OUT_OF_BOUNDS',message:`Метка ${a.label.text}: выходит за рамку листа`});if(sections.some(other=>other!==a.owner&&other.sheet_id===a.label.sheet_id&&intersects(a.box,physical.get(other)!)))issues.push({severity:'warning',code:'LABEL_OVERLAP',message:`Метка ${a.label.text}: пересекает другой компонент или его подпись`});for(let j=i+1;j<labelBoxes.length;j++){const b=labelBoxes[j];if(a.label.sheet_id===b.label.sheet_id&&intersects(a.box,b.box))issues.push({severity:'warning',code:'LABEL_OVERLAP',message:`Пересекаются метки ${a.label.text} и ${b.label.text}`});}}
 s.layout.routes=routed.routes;return{schematic:s,sections,routes:routed.routes,labels:routed.labels,issues};
}

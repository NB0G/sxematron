import {bundledDrawingFont,DRAWING_FONT_SCALE} from './font.js';
import type {Point,Primitive,Section,PlacedSection,Pin} from './types.js';
export const PAGE={width:420,height:297,frame:{x:20,y:5,width:395,height:287},drawing:{x:25,y:15,right:410,bottom:285},stamp:{x:230,y:237,width:185,height:55},grid:2.5};
export type Bounds={x:number;y:number;right:number;bottom:number};
export const round=(n:number)=>Math.round(n*1000)/1000;
export const snap=(n:number,step=2.5)=>round(Math.round(n/step)*step);
export const same=(a:Point,b:Point)=>Math.abs(a.x-b.x)<0.001&&Math.abs(a.y-b.y)<0.001;
export function transform(p:Point,rotation=0,mirror=false):Point {let x=mirror?-p.x:p.x,y=p.y;switch((rotation%360+360)%360){case 90:return {x:-y,y:x};case 180:return{x:-x,y:-y};case 270:return{x:y,y:-x};default:return{x,y};}}
const textCache=new Map<string,Bounds>();
export function drawingTextBounds(text:string,x:number,y:number,size=3.5,align='left'):Bounds{
 const key=JSON.stringify([text,size,align]);
 let bounds=textCache.get(key);
 if(!bounds){
  const font=bundledDrawingFont(),height=round(size*DRAWING_FONT_SCALE);
  const width=font.getAdvanceWidth(text,height,{kerning:true});
  const offset=align==='center'?-width/2:align==='right'?-width:0;
  const {x1,y1,x2,y2}=font.getPath(text,offset,0,height,{kerning:true}).getBoundingBox();
  bounds={x:x1,y:y1,right:x2,bottom:y2};
  if(textCache.size>=4096)textCache.clear();
  textCache.set(key,bounds);
 }
 return {x:x+bounds.x,y:y+bounds.y,right:x+bounds.right,bottom:y+bounds.bottom};
}
const corners=(b:Bounds)=>[{x:b.x,y:b.y},{x:b.right,y:b.y},{x:b.right,y:b.bottom},{x:b.x,y:b.bottom}];
function graphicPoints(p:Primitive):Point[]{let pts:Point[]=[];const x=p.x??0,y=p.y??0;if(p.kind==='group')pts=(p.children??[]).flatMap(graphicPoints);else if(p.kind==='line')pts=[{x,y},{x:p.x2??x,y:p.y2??y}];else if(p.kind==='rectangle')pts=corners({x,y,right:x+(p.width??0),bottom:y+(p.height??0)});else if(p.kind==='circle'||p.kind==='arc'){const r=p.r??0;pts=corners({x:x-r,y:y-r,right:x+r,bottom:y+r});}else if(p.kind==='text'){pts=corners(drawingTextBounds(p.text??'',x,y,3.5,p.align));}else pts=p.points??[];return pts.map(a=>{const t=transform(a,p.rotation,p.mirror);return p.kind==='group'?transform({x:a.x+x,y:a.y+y},p.rotation,p.mirror):t;});}
function symbolPoints(s:Section):Point[]{
 const pts=s.graphics.flatMap(graphicPoints);
 for(const p of s.pins){
  pts.push({x:p.x,y:p.y});
  const d={left:{x:1,y:0},right:{x:-1,y:0},top:{x:0,y:1},bottom:{x:0,y:-1}}[p.side];
  pts.push({x:p.x+d.x*(p.length??5),y:p.y+d.y*(p.length??5)});
 }
 return pts.length?pts:[{x:0,y:0},{x:10,y:10}];
}
function pointBounds(pts:Point[]):Bounds{return {x:Math.min(...pts.map(p=>p.x)),y:Math.min(...pts.map(p=>p.y)),right:Math.max(...pts.map(p=>p.x)),bottom:Math.max(...pts.map(p=>p.y))};}
export function turnBounds(b:Bounds,rotation:number,mirror:boolean){return pointBounds([{x:b.x,y:b.y},{x:b.right,y:b.y},{x:b.right,y:b.bottom},{x:b.x,y:b.bottom}].map(p=>transform(p,rotation,mirror)));}
export const isQuarterTurn=(rotation:number)=>Math.abs(rotation%180)===90;
export const hasTurnedCaption=(rotation:number)=>rotation%360!==0;
function turnedCaption(body:Bounds,rotation:number){return isQuarterTurn(rotation)?{x:body.right+2,y:(body.y+body.bottom)/2+3}:{x:body.x,y:body.y-4};}
export function sectionCaption(s:Section,rotation:number,mirror:boolean,caption?:{value?:string;designator?:string}){
 const body=pointBounds(symbolPoints(s).map(p=>transform(p,rotation,mirror)));
 const p=hasTurnedCaption(rotation)?turnedCaption(body,rotation):{x:0,y:-4};
 const label=(caption?.designator??'XXXX')+(s.section_id==='BODY'?'':'.'+s.section_id);
 const pins=s.pins.map(pin=>{
  const a=transform(pin,rotation,mirror),d=pinDirection({rotation,mirror},pin);
  return {a,b:{x:a.x+8*d.x,y:a.y+8*d.y},d};
 });
 const overlaps=(point:Point)=>{
  const box=drawingTextBounds(label,point.x,point.y),value=caption?.value&&drawingTextBounds(caption.value,point.x,point.y-4);
  return pins.filter(({a,b})=>segmentHitsBounds(a,b,box)||!!value&&segmentHitsBounds(a,b,value));
 };
 const blocked=overlaps(p);
 if(!blocked.length)return p;
 const right=Math.max(p.x,...pins.filter(({d})=>d.y!==0).map(({a})=>a.x+2.5));
 const candidates=[{x:right,y:p.y},{x:p.x,y:body.y-6},{x:body.right+3,y:body.y-3}];
 return candidates.find(point=>!overlaps(point).length)??candidates[2];
}
export function sectionBounds(s:Section,rotation=0,mirror=false,caption?:{value?:string;designator?:string;label_padding?:Partial<Record<'left'|'right'|'top'|'bottom',number>>}):Bounds{
 const pts=symbolPoints(s),b=pointBounds(pts);
 b.x-=caption?.label_padding?.left??0;b.right+=caption?.label_padding?.right??0;
 b.y-=caption?.label_padding?.top??0;b.bottom+=caption?.label_padding?.bottom??0;
 return pointBounds([...corners(turnBounds(b,rotation,mirror)),...sectionTextBounds(s,rotation,mirror,caption).flatMap(corners)]);
}
function sectionTextBounds(s:Section,rotation:number,mirror:boolean,caption?:{value?:string;designator?:string}){
 const p=sectionCaption(s,rotation,mirror,caption);
 const label=(caption?.designator??'XXXX')+(s.section_id==='BODY'?'':'.'+s.section_id);
 const bounds=[drawingTextBounds(label,p.x,p.y)];
 if(caption?.value)bounds.push(drawingTextBounds(caption.value,p.x,p.y-4));
 const labels=bounds;
 for(const pin of s.pins){
  const a=transform(pin,rotation,mirror);
  if(rotation||mirror){
   const d=pinDirection({rotation,mirror},pin);
   labels.push(drawingTextBounds(pin.number,a.x+(d.x>0?-1:1),a.y+(d.y<0?3.2:-1),2.5,d.x>0?'right':'left'));
  }else{
   labels.push(drawingTextBounds(pin.number,a.x+(pin.side==='right'?-1:1),a.y+(pin.side==='top'?2:-1),2.5,pin.side==='right'?'right':'left'));
  }
 }
 return labels;
}
export function printedTextBounds(s:PlacedSection):Bounds[]{
 return sectionTextBounds(s.section,s.rotation,s.mirror,s.instance).map(b=>({
  x:round(b.x+s.position.x-.2),y:round(b.y+s.position.y-.2),
  right:round(b.right+s.position.x+.2),bottom:round(b.bottom+s.position.y+.2)
 }));
}
export function pinLead(s:PlacedSection,p:Pin):[Point,Point]{
 const a=pinPosition(s,p),d=pinDirection(s,p),length=p.length??5;
 return [a,{x:round(a.x-d.x*length),y:round(a.y-d.y*length)}];
}
export function printedSectionParts(s:PlacedSection){
 const body=placedBodyBounds(s,.175);
 const pins=s.section.pins.map(p=>{
  const [a,b]=pinLead(s,p);
  return {x:Math.min(a.x,b.x)-.175,y:Math.min(a.y,b.y)-.175,right:Math.max(a.x,b.x)+.175,bottom:Math.max(a.y,b.y)+.175};
 });
 return [...(body?[body]:[]),...printedTextBounds(s),...pins];
}
export function segmentHitsBounds(a:Point,b:Point,box:Bounds){
 if(a.y===b.y)return a.y>box.y&&a.y<box.bottom&&Math.max(a.x,b.x)>box.x&&Math.min(a.x,b.x)<box.right;
 if(a.x===b.x)return a.x>box.x&&a.x<box.right&&Math.max(a.y,b.y)>box.y&&Math.min(a.y,b.y)<box.bottom;
 return true;
}
/** Graphics only. Pin leads are not a solid case between terminal tips. */
export function placedBodyBounds(s:PlacedSection,padding=0):Bounds|undefined{
 const pts=s.section.graphics.flatMap(graphicPoints);
 if(!pts.length)return undefined;
 const b=pointBounds(pts.map(p=>transform(p,s.rotation,s.mirror)));
 return {x:round(s.position.x+b.x-padding),y:round(s.position.y+b.y-padding),right:round(s.position.x+b.right+padding),bottom:round(s.position.y+b.bottom+padding)};
}
export function placedBounds(s:PlacedSection,padding=0):Bounds{const b=sectionBounds(s.section,s.rotation,s.mirror,{...s.instance,label_padding:s.label_padding});return{x:s.position.x+b.x-padding,y:s.position.y+b.y-padding,right:s.position.x+b.right+padding,bottom:s.position.y+b.bottom+padding};}
export function intersects(a:Bounds,b:Bounds,gap=0){return a.x<b.right+gap&&a.right+gap>b.x&&a.y<b.bottom+gap&&a.bottom+gap>b.y;}
export function inside(p:Point,b:Bounds){return p.x>b.x&&p.x<b.right&&p.y>b.y&&p.y<b.bottom;}
export function pinPosition(s:PlacedSection,p:Pin):Point{const t=transform(p,s.rotation,s.mirror);return{x:round(t.x+s.position.x),y:round(t.y+s.position.y)};}
export function pinDirection(s:Pick<PlacedSection,'rotation'|'mirror'>,p:Pin):Point{return transform({left:{x:-1,y:0},right:{x:1,y:0},top:{x:0,y:-1},bottom:{x:0,y:1}}[p.side],s.rotation,s.mirror);}
export function simplify(points:Point[]):Point[]{const out:Point[]=[];for(const p of points){if(out.length&&same(out[out.length-1],p))continue;const a=out.at(-2),b=out.at(-1);if(a&&b&&((a.x===b.x&&b.x===p.x)||(a.y===b.y&&b.y===p.y)))out.pop();out.push({x:round(p.x),y:round(p.y)});}return out;}
export function pointOnSegment(p:Point,a:Point,b:Point){return (Math.abs(a.x-b.x)<.001&&Math.abs(p.x-a.x)<.001&&p.y>=Math.min(a.y,b.y)-.001&&p.y<=Math.max(a.y,b.y)+.001)||(Math.abs(a.y-b.y)<.001&&Math.abs(p.y-a.y)<.001&&p.x>=Math.min(a.x,b.x)-.001&&p.x<=Math.max(a.x,b.x)+.001);}

export const WIRING_STAMP:Bounds={x:PAGE.stamp.x-1,y:PAGE.stamp.y-1,right:415,bottom:292};

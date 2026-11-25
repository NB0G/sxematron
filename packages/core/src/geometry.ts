import type {Point,Primitive,Section,PlacedSection,Pin} from './types.js';
export const PAGE={width:420,height:297,frame:{x:20,y:5,width:395,height:287},drawing:{x:25,y:15,right:410,bottom:285},stamp:{x:230,y:237,width:185,height:55},grid:2.5};
export type Bounds={x:number;y:number;right:number;bottom:number};
export const round=(n:number)=>Math.round(n*1000)/1000;
export const snap=(n:number,step=2.5)=>round(Math.round(n/step)*step);
export const same=(a:Point,b:Point)=>Math.abs(a.x-b.x)<0.001&&Math.abs(a.y-b.y)<0.001;
export function transform(p:Point,rotation=0,mirror=false):Point {let x=mirror?-p.x:p.x,y=p.y;switch((rotation%360+360)%360){case 90:return {x:-y,y:x};case 180:return{x:-x,y:-y};case 270:return{x:y,y:-x};default:return{x,y};}}
function graphicPoints(p:Primitive):Point[]{let pts:Point[]=[];const x=p.x??0,y=p.y??0;if(p.kind==='group')pts=(p.children??[]).flatMap(graphicPoints);else if(p.kind==='line')pts=[{x,y},{x:p.x2??x,y:p.y2??y}];else if(p.kind==='rectangle')pts=[{x,y},{x:x+(p.width??0),y:y+(p.height??0)}];else if(p.kind==='circle'||p.kind==='arc'){const r=p.r??0;pts=[{x:x-r,y:y-r},{x:x+r,y:y+r}];}else if(p.kind==='text'){const w=(p.text?.length??0)*1.8;const offset=p.align==='center'?-w/2:p.align==='right'?-w:0;pts=[{x:x+offset,y:y-3.5},{x:x+offset+w,y:y+1}];}else pts=p.points??[];return pts.map(a=>{const t=transform(a,p.rotation,p.mirror);return p.kind==='group'?transform({x:a.x+x,y:a.y+y},p.rotation,p.mirror):t;});}
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
function turnBounds(b:Bounds,rotation:number,mirror:boolean){return pointBounds([{x:b.x,y:b.y},{x:b.right,y:b.y},{x:b.right,y:b.bottom},{x:b.x,y:b.bottom}].map(p=>transform(p,rotation,mirror)));}
export const isQuarterTurn=(rotation:number)=>Math.abs(rotation%180)===90;
export const hasTurnedCaption=(rotation:number)=>rotation%360!==0;
function turnedCaption(body:Bounds,rotation:number){return isQuarterTurn(rotation)?{x:body.right+2,y:(body.y+body.bottom)/2+3}:{x:body.x,y:body.y-4};}
export function sectionCaption(s:Section,rotation:number,mirror:boolean){return turnedCaption(pointBounds(symbolPoints(s).map(p=>transform(p,rotation,mirror))),rotation);}
export function sectionBounds(s:Section,rotation=0,mirror=false,caption?:{value?:string;designator?:string;label_padding?:Partial<Record<'left'|'right'|'top'|'bottom',number>>}):Bounds{
 const pts=symbolPoints(s), chars=Math.max(caption?.value?.length??0,(caption?.designator?.length??4)+(s.section_id==='BODY'?0:s.section_id.length+1));
 if(!hasTurnedCaption(rotation))pts.push({x:0,y:-12},{x:chars*1.8,y:-4});
 const b=pointBounds(pts);
 b.x-=caption?.label_padding?.left??0;b.right+=caption?.label_padding?.right??0;
 b.y-=caption?.label_padding?.top??0;b.bottom+=caption?.label_padding?.bottom??0;
 const turned=turnBounds(b,rotation,mirror);
 if(hasTurnedCaption(rotation)){
  const c=turnedCaption(pointBounds(pts.map(p=>transform(p,rotation,mirror))),rotation);
  turned.right=Math.max(turned.right,c.x+chars*3.5);
  turned.y=Math.min(turned.y,c.y-(caption?.value?8:4));
  turned.bottom=Math.max(turned.bottom,c.y+.8);
 }
 return turned;
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
export function pinDirection(s:PlacedSection,p:Pin):Point{return transform({left:{x:-1,y:0},right:{x:1,y:0},top:{x:0,y:-1},bottom:{x:0,y:1}}[p.side],s.rotation,s.mirror);}
export function simplify(points:Point[]):Point[]{const out:Point[]=[];for(const p of points){if(out.length&&same(out[out.length-1],p))continue;const a=out.at(-2),b=out.at(-1);if(a&&b&&((a.x===b.x&&b.x===p.x)||(a.y===b.y&&b.y===p.y)))out.pop();out.push({x:round(p.x),y:round(p.y)});}return out;}
export function pointOnSegment(p:Point,a:Point,b:Point){return (Math.abs(a.x-b.x)<.001&&Math.abs(p.x-a.x)<.001&&p.y>=Math.min(a.y,b.y)-.001&&p.y<=Math.max(a.y,b.y)+.001)||(Math.abs(a.y-b.y)<.001&&Math.abs(p.y-a.y)<.001&&p.x>=Math.min(a.x,b.x)-.001&&p.x<=Math.max(a.x,b.x)+.001);}

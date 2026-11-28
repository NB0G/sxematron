import {pointOnSegment, round, same} from './geometry.js';
import type {Point, WireRoute} from './types.js';

export type Conductor = {a:Point; b:Point; wire:WireRoute; index:number};
export const physicalPinKey=(id:string,number:string)=>id+'\0'+number;
export const distance=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);

export function conductors(routes:readonly WireRoute[]):Conductor[]{
 return routes.flatMap((wire,index)=>{
  const points=wire.points.map(({x,y})=>({x:round(x),y:round(y)}));
  const parts:Conductor[]=[];
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i],last=parts.at(-1);
   if(same(a,b))continue;
   if(last&&same(a,last.b)&&pointOnSegment(a,last.a,b))last.b=b;
   else parts.push({a,b,wire,index});
  }
  return parts;
 });
}

export function parallelGap(a:Point,b:Point,c:Point,d:Point){
 const vertical=a.x===b.x;
 if(vertical!==(c.x===d.x))return;
 const [axis,along]=vertical?['x','y'] as const:['y','x'] as const;
 const start=Math.max(Math.min(a[along],b[along]),Math.min(c[along],d[along]));
 const end=Math.min(Math.max(a[along],b[along]),Math.max(c[along],d[along]));
 if(end>start+.001)return Math.abs(a[axis]-c[axis]);
}

/** A collinear contact needs no new dot by itself. Include its ends so a
 * third branch at either end is recognized the same way in print and audit. */
export function contactPoints(a:Point,b:Point,c:Point,d:Point):Point[]{
 const vertical=a.x===b.x;
 if(vertical!==(c.x===d.x)){
  const point=vertical?{x:a.x,y:c.y}:{x:c.x,y:a.y};
  return pointOnSegment(point,a,b)&&pointOnSegment(point,c,d)?[point]:[];
 }
 return [a,b,c,d].filter(p=>pointOnSegment(p,a,b)&&pointOnSegment(p,c,d));
}

export function visitPairs(parts:Conductor[],margin:number,visit:(a:Conductor,b:Conductor)=>void){
 const left=(s:Conductor)=>Math.min(s.a.x,s.b.x);
 const ordered=parts.slice().sort((a,b)=>left(a)-left(b));
 for(let i=0;i<ordered.length;i++){
  const a=ordered[i],right=Math.max(a.a.x,a.b.x)+margin;
  for(let j=i+1;j<ordered.length&&left(ordered[j])<=right+.001;j++)visit(a,ordered[j]);
 }
}

export function junctionPoints(routes:WireRoute[]):Point[]{
 const parts=conductors(routes),points=new Map<string,Point>();
 visitPairs(parts,0,(a,b)=>{
  if(a.wire.net_id!==b.wire.net_id)return;
  for(const p of contactPoints(a.a,a.b,b.a,b.b)){
   const directions=new Set<string>();
   for(const s of parts)if(s.wire.net_id===a.wire.net_id&&pointOnSegment(p,s.a,s.b)){
    if(Math.min(s.a.x,s.b.x)<p.x)directions.add('left');
    if(Math.max(s.a.x,s.b.x)>p.x)directions.add('right');
    if(Math.min(s.a.y,s.b.y)<p.y)directions.add('up');
    if(Math.max(s.a.y,s.b.y)>p.y)directions.add('down');
   }
   if(directions.size>=3)points.set(JSON.stringify([round(p.x),round(p.y)]),p);
  }
 });
 return [...points.values()].sort((a,b)=>a.x-b.x||a.y-b.y);
}

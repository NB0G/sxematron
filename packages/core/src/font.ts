/** Local OpenGOST type B font and vector export. No network or DOM dependencies. */
import opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import { FONT_BASE64 } from './font-data.js';

export const DRAWING_FONT_FAMILY = 'OpenGOST type B';
// OpenGOST cap height = 1000 units, em = 1700: requested sizes are physical uppercase heights.
export const DRAWING_FONT_SCALE = 1.7;
export const DRAWING_FONT_URL = '/fonts/OpenGOSTTypeB-Regular.ttf';
export function parseDrawingFont(buffer: ArrayBuffer): Font {
  return opentype.parse(buffer);
}
let bundled:Font|undefined;
export function bundledDrawingFont():Font {
  if (!bundled) {
    const binary=atob(FONT_BASE64),u=new Uint8Array(binary.length);
    for(let i=0;i<u.length;i++)u[i]=binary.charCodeAt(i);
    bundled=parseDrawingFont(u.buffer);
  }
  return bundled;
}
function xml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
}
function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
    }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity.toLowerCase()] ?? '\uFFFD';
  });
}
function attributes(s:string):Record<string,string> {
  const result:Record<string,string> = {};
  for(const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[m[1]]=decode(m[2]??m[3]);
  return result;
}
/** Convert text emitted by the shared renderer into paths; all coordinates remain mm. */
export function outlineSvgText(svg: string, fontBuffer: ArrayBuffer | Font): string {
  const font = fontBuffer instanceof ArrayBuffer ? parseDrawingFont(fontBuffer) : fontBuffer;
  return svg.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g, (_, raw: string, contents: string) => {
    if (/<\/?(?:tspan|textPath)\b/.test(contents)) throw new Error('Векторизация: вложенные текстовые элементы не поддерживаются.');
    const a = attributes(raw);
    const text = decode(contents);
    const x = Number(a.x ?? '0'), y = Number(a.y ?? '0'), size = Number(a['font-size'] ?? '3.5');
    if (![x,y,size].every(Number.isFinite) || size<=0) throw new Error('Векторизация: некорректная геометрия текста.');
    const unsupported = [...text].filter(ch => !/\s/.test(ch) && font.charToGlyphIndex(ch)===0);
    if (unsupported.length) throw new Error(`Шрифт не содержит символы: ${[...new Set(unsupported)].join(' ')}`);
    const width=font.getAdvanceWidth(text,size,{kerning:true});
    const anchor=a['text-anchor'];
    const originX=anchor==='middle'?x-width/2:anchor==='end'?x-width:x;
    let originY=y;
    const baseline=a['dominant-baseline']??a['alignment-baseline'];
    if(baseline==='middle'||baseline==='central') originY += (font.ascender+font.descender)/font.unitsPerEm*size/2;
    else if(baseline==='hanging'||baseline==='text-before-edge') originY += font.ascender/font.unitsPerEm*size;
    const path = font.getPath(text,originX,originY,size,{kerning:true});
    const d=path.toPathData(5);
    const length=a.textLength?Number(a.textLength):undefined;
    const lengthTransform=length!==undefined&&Number.isFinite(length)&&length>0&&width>0
      ? `translate(${x} 0) scale(${length/width} 1) translate(${-x} 0)` : '';
    const transform=[a.transform??'',lengthTransform].filter(Boolean).join(' ');
    const keep=['id','class','data-section','data-pin','data-net'];
    const extra=keep.filter(k=>a[k]).map(k=>` ${k}="${xml(a[k])}"`).join('');
    return `<path d="${d}" fill="${xml(a.fill??'#000')}" stroke="none"${transform?` transform="${xml(transform)}"`:''}${extra}><title>${xml(text)}</title></path>`;
  });
}

/** Embed the unchanged OFL font into editable SVG; use paths for printer portability. */
export function embedDrawingFont(svg:string, fontBase64:string):string {
  if(!/^[A-Za-z0-9+/=\r\n]+$/.test(fontBase64)) throw new Error('Некорректный шрифт Base64.');
  const style=`<defs><style>@font-face{font-family:'${DRAWING_FONT_FAMILY}';src:url(data:font/ttf;base64,${fontBase64.replace(/\s/g,'')}) format('truetype');font-weight:400;font-style:normal}</style></defs>`;
  return svg.replace(/(<svg\b[^>]*>)/,`$1${style}`);
}

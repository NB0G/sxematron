export const PAGE = { width: 420, height: 297, frame: { x: 20, y: 5, width: 395, height: 287 }, drawing: { x: 25, y: 15, right: 410, bottom: 285 }, stamp: { x: 230, y: 237, width: 185, height: 55 }, grid: 2.5 };
export const round = (n) => Math.round(n * 1000) / 1000;
export const snap = (n, step = 2.5) => round(Math.round(n / step) * step);
export const same = (a, b) => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
export function transform(p, rotation = 0, mirror = false) { let x = mirror ? -p.x : p.x, y = p.y; switch ((rotation % 360 + 360) % 360) {
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default: return { x, y };
} }
function graphicPoints(p) { let pts = []; const x = p.x ?? 0, y = p.y ?? 0; if (p.kind === 'group')
    pts = (p.children ?? []).flatMap(graphicPoints);
else if (p.kind === 'line')
    pts = [{ x, y }, { x: p.x2 ?? x, y: p.y2 ?? y }];
else if (p.kind === 'rectangle')
    pts = [{ x, y }, { x: x + (p.width ?? 0), y: y + (p.height ?? 0) }];
else if (p.kind === 'circle' || p.kind === 'arc') {
    const r = p.r ?? 0;
    pts = [{ x: x - r, y: y - r }, { x: x + r, y: y + r }];
}
else if (p.kind === 'text') {
    const w = (p.text?.length ?? 0) * 1.8;
    const offset = p.align === 'center' ? -w / 2 : p.align === 'right' ? -w : 0;
    pts = [{ x: x + offset, y: y - 3.5 }, { x: x + offset + w, y: y + 1 }];
}
else
    pts = p.points ?? []; return pts.map(a => { const t = transform(a, p.rotation, p.mirror); return p.kind === 'group' ? transform({ x: a.x + x, y: a.y + y }, p.rotation, p.mirror) : t; }); }
export function sectionBounds(s, rotation = 0, mirror = false, caption) {
    const pts = s.graphics.flatMap(graphicPoints);
    for (const p of s.pins) {
        pts.push({ x: p.x, y: p.y });
        const d = { left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 } }[p.side];
        pts.push({ x: p.x + d.x * (p.length ?? 5), y: p.y + d.y * (p.length ?? 5) });
    }
    pts.push({ x: 0, y: -12 }, { x: Math.max((caption?.value?.length ?? 0) * 1.8, ((caption?.designator?.length ?? 4) + (s.section_id === 'BODY' ? 0 : s.section_id.length + 1)) * 1.8), y: -4 });
    const bb = pts.length ? { x: Math.min(...pts.map(p => p.x)), y: Math.min(...pts.map(p => p.y)), right: Math.max(...pts.map(p => p.x)), bottom: Math.max(...pts.map(p => p.y)) } : { x: 0, y: 0, right: 10, bottom: 10 }; // Position/value caption participates in obstacle bounds.
    bb.x -= caption?.label_padding?.left ?? 0;
    bb.right += caption?.label_padding?.right ?? 0;
    bb.y -= caption?.label_padding?.top ?? 0;
    bb.bottom += caption?.label_padding?.bottom ?? 0;
    const corners = [{ x: bb.x, y: bb.y }, { x: bb.right, y: bb.y }, { x: bb.right, y: bb.bottom }, { x: bb.x, y: bb.bottom }].map(p => transform(p, rotation, mirror));
    return { x: Math.min(...corners.map(p => p.x)), y: Math.min(...corners.map(p => p.y)), right: Math.max(...corners.map(p => p.x)), bottom: Math.max(...corners.map(p => p.y)) };
}
export function placedBounds(s, padding = 0) { const b = sectionBounds(s.section, s.rotation, s.mirror, { ...s.instance, label_padding: s.label_padding }); return { x: s.position.x + b.x - padding, y: s.position.y + b.y - padding, right: s.position.x + b.right + padding, bottom: s.position.y + b.bottom + padding }; }
export function intersects(a, b, gap = 0) { return a.x < b.right + gap && a.right + gap > b.x && a.y < b.bottom + gap && a.bottom + gap > b.y; }
export function inside(p, b) { return p.x > b.x && p.x < b.right && p.y > b.y && p.y < b.bottom; }
export function pinPosition(s, p) { const t = transform(p, s.rotation, s.mirror); return { x: round(t.x + s.position.x), y: round(t.y + s.position.y) }; }
export function pinDirection(s, p) { return transform({ left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }[p.side], s.rotation, s.mirror); }
export function simplify(points) { const out = []; for (const p of points) {
    if (out.length && same(out[out.length - 1], p))
        continue;
    const a = out.at(-2), b = out.at(-1);
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)))
        out.pop();
    out.push({ x: round(p.x), y: round(p.y) });
} return out; }
export function pointOnSegment(p, a, b) { return (Math.abs(a.x - b.x) < .001 && Math.abs(p.x - a.x) < .001 && p.y >= Math.min(a.y, b.y) - .001 && p.y <= Math.max(a.y, b.y) + .001) || (Math.abs(a.y - b.y) < .001 && Math.abs(p.y - a.y) < .001 && p.x >= Math.min(a.x, b.x) - .001 && p.x <= Math.max(a.x, b.x) + .001); }

import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Divider, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { componentPreview, validateComponent, transform } from '../../../packages/core/src/index.js';
import type { ComponentDefinition, Issue, Pin, Point, Primitive, Section } from '../../../packages/core/src/types.js';

type Props = { initial?: ComponentDefinition; isNew?: boolean; onSaved: () => void; onNotify: (text: string) => void };
type Tool = 'select' | Primitive['kind'] | 'pin';
let primitiveSequence=0;const newId = () => `p_${Date.now().toString(36)}_${(++primitiveSequence).toString(36)}`;
const clone = <T,>(v: T): T => structuredClone(v);
const duplicatePrimitive = (p: Primitive): Primitive => ({ ...clone(p), id: newId(), ...(p.children ? { children: p.children.map(duplicatePrimitive) } : {}) });
const blank = (): ComponentDefinition => ({ format_version: '1.0', component_code: `CUSTOM_${Date.now().toString(36).toUpperCase()}`, name: 'Новый компонент', category: 'Пользовательские', positional_prefix: 'DA', physical_pins: [{ number: '1' }, { number: '2' }], variants: [{ variant_code: '01', name: 'Основное представление', sections: [{ section_id: 'BODY', graphics: [], pins: [] }] }] });
const toolNames: Record<Tool, string> = { select: 'Выбор', line: 'Линия', polyline: 'Ломаная', rectangle: 'Прямоугольник', circle: 'Окружность', arc: 'Дуга', polygon: 'Многоугольник', text: 'Текст', group: 'Группа', pin: 'Вывод' };
const numeric = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0;
const movePrimitive = (p: Primitive, dx: number, dy: number): Primitive => {
  // SVG rotates/mirrors the primitive's coordinate system. Convert the canvas
  // displacement back to that local system before changing its coordinates.
  const inverse = transform({ x: dx, y: dy }, -(p.rotation ?? 0));
  dx = p.mirror ? -inverse.x : inverse.x; dy = inverse.y;
  const r = { ...p };
  if (p.kind === 'polyline' || p.kind === 'polygon') r.points = p.points?.map(a => ({ x: a.x + dx, y: a.y + dy }));
  else { r.x = (p.x ?? 0) + dx; r.y = (p.y ?? 0) + dy; if (p.kind === 'line') { r.x2 = (p.x2 ?? 0) + dx; r.y2 = (p.y2 ?? 0) + dy; } }
  return r;
};
function drawingPoints(p: Primitive): Point[] {
  const x = p.x ?? 0, y = p.y ?? 0;
  let points: Point[];
  if (p.kind === 'group') points = (p.children ?? []).flatMap(drawingPoints).map(a => ({ x: a.x + x, y: a.y + y }));
  else if (p.kind === 'line') points = [{ x, y }, { x: p.x2 ?? x, y: p.y2 ?? y }];
  else if (p.kind === 'rectangle') points = [{ x, y }, { x: x + (p.width ?? 0), y }, { x, y: y + (p.height ?? 0) }, { x: x + (p.width ?? 0), y: y + (p.height ?? 0) }];
  else if (p.kind === 'circle' || p.kind === 'arc') { const r = p.r ?? 0; points = [{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x - r, y: y + r }, { x: x + r, y: y + r }]; }
  else if (p.kind === 'text') { const width = Math.max(1, (p.text?.length ?? 0) * 1.8), offset = p.align === 'center' ? -width / 2 : p.align === 'right' ? -width : 0; points = [{ x: x + offset, y: y - 3.5 }, { x: x + offset + width, y }, { x: x + offset, y }, { x: x + offset + width, y: y - 3.5 }]; }
  else points = p.points?.length ? p.points : [{ x, y }];
  if (!points.length) points = [{ x, y }];
  return points.map(a => transform(a, p.rotation, p.mirror));
}
function drawingBounds(p: Primitive) { const points = drawingPoints(p); return { left: Math.min(...points.map(a => a.x)), right: Math.max(...points.map(a => a.x)), top: Math.min(...points.map(a => a.y)), bottom: Math.max(...points.map(a => a.y)) }; }
function PrimitiveShape({ p, selected, onDown }: { p: Primitive; selected?: boolean; onDown?: (e: React.PointerEvent<SVGGElement>) => void }) {
  const x = p.x ?? 0, y = p.y ?? 0;
  let shape: React.ReactNode;
  switch (p.kind) {
    case 'line': shape = <line x1={x} y1={y} x2={p.x2 ?? 10} y2={p.y2 ?? 0} />; break;
    case 'rectangle': shape = <rect x={x} y={y} width={Math.max(0, p.width ?? 10)} height={Math.max(0, p.height ?? 10)} />; break;
    case 'circle': shape = <circle cx={x} cy={y} r={Math.max(.1, p.r ?? 5)} />; break;
    case 'arc': { const a = (p.start ?? 0) * Math.PI / 180, b = (p.end ?? 180) * Math.PI / 180, r = p.r ?? 5; shape = <path d={`M ${x + r * Math.cos(a)} ${y + r * Math.sin(a)} A ${r} ${r} 0 ${Math.abs((p.end ?? 180) - (p.start ?? 0)) > 180 ? 1 : 0} ${(p.end ?? 180) >= (p.start ?? 0) ? 1 : 0} ${x + r * Math.cos(b)} ${y + r * Math.sin(b)}`} />; break; }
    case 'polyline': shape = <polyline points={(p.points ?? []).map(a => `${a.x},${a.y}`).join(' ')} />; break;
    case 'polygon': shape = <polygon points={(p.points ?? []).map(a => `${a.x},${a.y}`).join(' ')} />; break;
    case 'text': shape = <text x={x} y={y} fill="currentColor" stroke="none" textAnchor={p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start'} fontSize="5.95">{p.text ?? 'Текст'}</text>; break;
    case 'group': shape = <g transform={`translate(${x} ${y})`}>{p.children?.map(c => <PrimitiveShape key={c.id} p={c} />)}</g>; break;
  }
  return <g data-primitive={p.id} onPointerDown={onDown} fill="none" stroke={selected ? '#3457d5' : 'currentColor'} color={selected ? '#3457d5' : '#18212c'} strokeWidth={selected ? .65 : .35} style={{ cursor: onDown ? 'move' : undefined }} transform={`rotate(${p.rotation ?? 0}) scale(${p.mirror ? -1 : 1} 1)`}>{shape}{selected && <circle cx={x} cy={y} r=".8" fill="#3457d5" stroke="white" strokeWidth=".2" />}</g>;
}

export default function ComponentBuilder({ initial, isNew=false, onSaved, onNotify }: Props) {
  const [definition, setDefinition] = useState<ComponentDefinition>(() => clone(initial ?? blank()));
  const [savedCode, setSavedCode] = useState<string | undefined>(isNew?undefined:initial?.component_code);
  const [savedSnapshot, setSavedSnapshot] = useState(() => initial && isNew ? '' : JSON.stringify(definition));
  const [variantIndex, setVariantIndex] = useState(0), [sectionIndex, setSectionIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [pinIndex, setPinIndex] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>('select'), [snap, setSnap] = useState(true), [zoom, setZoom] = useState(1);
  const [issues, setIssues] = useState<Issue[]>([]), [busy, setBusy] = useState(false), [showPreview, setShowPreview] = useState(false);
  const [past, setPast] = useState<ComponentDefinition[]>([]), [future, setFuture] = useState<ComponentDefinition[]>([]);
  const [pinText, setPinText] = useState((initial?.physical_pins ?? [{ number: '1' }, { number: '2' }]).map(p => p.number).join(', '));
  const svgRef = useRef<SVGSVGElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ start: Point; definition: ComponentDefinition; ids: string[]; pin?: number; drawing?: string } | null>(null);
  useEffect(() => { const d = clone(initial ?? blank()); setDefinition(d); setSavedSnapshot(initial && isNew ? '' : JSON.stringify(d)); setSavedCode(isNew?undefined:initial?.component_code); setPinText(d.physical_pins.map(p => p.number).join(', ')); setVariantIndex(0); setSectionIndex(0); setSelected([]); setPinIndex(null); setPast([]); setFuture([]); setIssues([]); }, [initial,isNew]);
  const dirty = JSON.stringify(definition) !== savedSnapshot || [...new Set(pinText.split(/[,;\s]+/).filter(Boolean))].join(',') !== definition.physical_pins.map(p => p.number).join(',');
  useEffect(() => { const handle = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', handle); return () => window.removeEventListener('beforeunload', handle); }, [dirty]);
  const variant = definition.variants[variantIndex] ?? definition.variants[0];
  const section = variant?.sections[sectionIndex] ?? variant?.sections[0];
  const chosen = section?.graphics.find(p => selected.includes(p.id));
  const chosenPin = pinIndex === null ? undefined : section?.pins[pinIndex];
  const commit = (next: ComponentDefinition) => { setPast(a => [...a.slice(-59), clone(definition)]); setFuture([]); setDefinition(next); setIssues([]); };
  const update = (change: (d: ComponentDefinition) => void) => { const d = clone(definition); change(d); commit(d); };
  const mutateSection = (change: (s: Section) => void) => update(d => change(d.variants[variantIndex].sections[sectionIndex]));
  const setPrimitive = (key: keyof Primitive, value: unknown) => mutateSection(s => { const p = s.graphics.find(p => p.id === chosen?.id); if (p) Object.assign(p, { [key]: value }); });
  const setPin = (key: keyof Pin, value: unknown) => mutateSection(s => { if (pinIndex !== null && s.pins[pinIndex]) Object.assign(s.pins[pinIndex], { [key]: value }); });
  const undo = () => { const d = past.at(-1); if (!d) return; setFuture(f => [clone(definition), ...f]); setPast(p => p.slice(0, -1)); setDefinition(clone(d)); setSelected([]); setPinIndex(null); };
  const redo = () => { const d = future[0]; if (!d) return; setPast(p => [...p, clone(definition)]); setFuture(f => f.slice(1)); setDefinition(clone(d)); setSelected([]); setPinIndex(null); };
  const removeSelected = () => { if (pinIndex !== null) mutateSection(s => { s.pins.splice(pinIndex, 1); }); else if (selected.length) mutateSection(s => { s.graphics = s.graphics.filter(p => !selected.includes(p.id)); }); setSelected([]); setPinIndex(null); };
  useEffect(() => { const handle = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches('input,textarea,[contenteditable="true"]')) return; if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } else if (e.key === 'Delete') { e.preventDefault(); removeSelected(); } }; window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle); });
  const point = (e: React.PointerEvent): Point => { const el = svgRef.current!; const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(el.getScreenCTM()!.inverse()); const grid = snap ? 1.25 : .01; return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid }; };
  const startDrag = (e: React.PointerEvent<SVGGElement>, id: string, pin?: number) => {
    if (tool !== 'select') return; e.stopPropagation(); svgRef.current?.setPointerCapture(e.pointerId);
    const ids = pin === undefined ? e.ctrlKey || e.metaKey ? selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id] : selected.includes(id) ? selected : [id] : [];
    setSelected(ids); setPinIndex(pin ?? null); drag.current = { start: point(e), definition: clone(definition), ids, pin };
  };
  const beginDraw = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !section) return;
    if (tool === 'select') { setSelected([]); setPinIndex(null); return; }
    const start = point(e), d = clone(definition), s = d.variants[variantIndex].sections[sectionIndex];
    if (tool === 'pin') {
      const remaining = definition.physical_pins.find(p => !variant.sections.flatMap(s => s.pins).some(a => a.number === p.number));
      if (!remaining) { onNotify('Все физические выводы уже размещены в этом варианте. Добавьте номер в список выводов.'); return; }
      s.pins.push({ number: remaining.number, ...start, side: 'left', length: 5 }); commit(d); setPinIndex(s.pins.length - 1); setSelected([]); setTool('select'); return;
    }
    if (tool === 'group') { onNotify('Выделите несколько примитивов с Ctrl и нажмите «В группу».'); setTool('select'); return; }
    const p: Primitive = { id: newId(), kind: tool, x: start.x, y: start.y };
    if (tool === 'text') { p.text = 'Текст'; p.align = 'left'; s.graphics.push(p); commit(d); setSelected([p.id]); setTool('select'); return; }
    if (tool === 'rectangle') { p.width = 1.25; p.height = 1.25; }
    if (tool === 'circle' || tool === 'arc') { p.r = 1.25; if (tool === 'arc') { p.start = 0; p.end = 180; } }
    if (tool === 'line') { p.x2 = start.x; p.y2 = start.y; }
    if (tool === 'polyline' || tool === 'polygon') { delete p.x; delete p.y; p.points = [start, start, start]; }
    s.graphics.push(p); setDefinition(d); setSelected([p.id]); setPinIndex(null); svgRef.current?.setPointerCapture(e.pointerId); drag.current = { start, definition: clone(definition), ids: [p.id], drawing: p.id };
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return; const state = drag.current, at = point(e), dx = at.x - state.start.x, dy = at.y - state.start.y;
    if (state.drawing) {
      setDefinition(current => { const d = clone(current), s = d.variants[variantIndex].sections[sectionIndex], p = s.graphics.find(p => p.id === state.drawing)!; const start = state.start;
        if (p.kind === 'line') { p.x2 = at.x; p.y2 = at.y; }
        if (p.kind === 'rectangle') { p.x = Math.min(start.x, at.x); p.y = Math.min(start.y, at.y); p.width = Math.max(1.25, Math.abs(dx)); p.height = Math.max(1.25, Math.abs(dy)); }
        if (p.kind === 'circle' || p.kind === 'arc') p.r = Math.max(1.25, Math.round(Math.hypot(dx, dy) * 100) / 100);
        if (p.kind === 'polyline') p.points = [start, { x: at.x, y: start.y }, at];
        if (p.kind === 'polygon') p.points = [start, { x: at.x, y: start.y }, at]; return d;
      }); return;
    }
    const d = clone(state.definition), s = d.variants[variantIndex].sections[sectionIndex];
    if (state.pin !== undefined) { s.pins[state.pin].x += dx; s.pins[state.pin].y += dy; }
    else s.graphics = s.graphics.map(p => state.ids.includes(p.id) ? movePrimitive(p, dx, dy) : p);
    setDefinition(d);
  };
  const endDrag = () => { const state = drag.current; if (!state) return; setPast(a => [...a.slice(-59), state.definition]); setFuture([]); setIssues([]); drag.current = null; if (state.drawing) setTool('select'); };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { onNotify('Размер файла превышает 10 МБ.'); return; }
    try { const parsed = JSON.parse(await file.text()); const found = validateComponent(parsed); setIssues(found); if (found.some(x => x.severity === 'error')) return; commit(parsed); setVariantIndex(0); setSectionIndex(0); setSelected([]); setPinIndex(null); setSavedCode(undefined); setPinText(parsed.physical_pins.map((p: { number: string }) => p.number).join(', ')); onNotify('Определение загружено. Проверьте и сохраните его в библиотеку.'); } catch (e) { onNotify(`Не удалось прочитать компонент: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const download = () => { const blob = new Blob([JSON.stringify(definition, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${definition.component_code || 'component'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const save = async () => {
    const found = validateComponent(definition); setIssues(found); if (found.some(x => x.severity === 'error')) { onNotify('Исправьте ошибки определения перед сохранением.'); return; }
    setBusy(true);
    try {
      let method = savedCode ? 'PUT' : 'POST', path = savedCode ? `/api/components/${encodeURIComponent(savedCode)}` : '/api/components';
      let response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition) });
      if (response.status === 409 && !savedCode && window.confirm('Такой код уже есть в библиотеке. Заменить текущее определение?')) response = await fetch(`/api/components/${encodeURIComponent(definition.component_code)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error ?? JSON.stringify(body));
      setSavedCode(definition.component_code); setSavedSnapshot(JSON.stringify(definition)); onSaved(); onNotify('Компонент сохранён. Каталог обновлён.');
    } catch (e) { onNotify(`Ошибка сохранения: ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(false); }
  };
  const groupSelected = () => { if (selected.length < 2) { onNotify('Выделите минимум два примитива с Ctrl.'); return; } const id = newId(); mutateSection(s => { const children = s.graphics.filter(p => selected.includes(p.id)); s.graphics = [...s.graphics.filter(p => !selected.includes(p.id)), { id, kind: 'group', x: 0, y: 0, children }]; }); setSelected([id]); };
  const alignSelected = (edge: 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical') => {
    if (selected.length < 2) return;
    const shapes = section.graphics.filter(p => selected.includes(p.id));
    const bounds = shapes.map(drawingBounds);
    const union = { left: Math.min(...bounds.map(b => b.left)), right: Math.max(...bounds.map(b => b.right)), top: Math.min(...bounds.map(b => b.top)), bottom: Math.max(...bounds.map(b => b.bottom)) };
    mutateSection(s => { s.graphics = s.graphics.map(p => {
      if (!selected.includes(p.id)) return p;
      const b = drawingBounds(p);
      const dx = edge === 'left' ? union.left - b.left : edge === 'right' ? union.right - b.right : edge === 'horizontal' ? (union.left + union.right - b.left - b.right) / 2 : 0;
      const dy = edge === 'top' ? union.top - b.top : edge === 'bottom' ? union.bottom - b.bottom : edge === 'vertical' ? (union.top + union.bottom - b.top - b.bottom) / 2 : 0;
      return movePrimitive(p, dx, dy);
    }); });
  };
  const numericField = (label: string, key: keyof Primitive, fallback = 0) => <TextField key={key} label={label} type="number" size="small" value={Number(chosen?.[key] ?? fallback)} onChange={e => setPrimitive(key, numeric(e.target.value))} inputProps={{ step: 1.25 }} />;
  let preview = ''; if (showPreview) { try { preview = componentPreview(definition, variant?.variant_code, section?.section_id); } catch { preview = ''; } }

  return <Stack spacing={2}>
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><Box sx={{ flex: 1, minWidth: 200 }}><Typography variant="h5" fontWeight={700}>Конструктор УГО</Typography><Typography variant="body2" color="text.secondary">Варианты, секции и физические номера выводов · все размеры в мм</Typography></Box><Button onClick={() => inputRef.current?.click()}>Загрузить JSON</Button><Button onClick={download}>Скачать JSON</Button><Button variant="contained" disabled={busy} onClick={save}>Сохранить в библиотеку{dirty ? ' •' : ''}</Button><input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></Stack>
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 1.5 }}><TextField label="Постоянный код" size="small" value={definition.component_code} disabled={!!savedCode} onChange={e => update(d => { d.component_code = e.target.value; })} /><TextField label="Название компонента" size="small" value={definition.name} onChange={e => update(d => { d.name = e.target.value; })} /><TextField label="Категория" size="small" value={definition.category} onChange={e => update(d => { d.category = e.target.value; })} /><TextField label="Префикс обозначения" size="small" value={definition.positional_prefix} onChange={e => update(d => { d.positional_prefix = e.target.value; })} /><TextField label="Физические выводы через запятую" size="small" value={pinText} onChange={e => setPinText(e.target.value)} onBlur={() => { const numbers = [...new Set(pinText.split(/[,;\s]+/).filter(Boolean))]; if (numbers.join() !== definition.physical_pins.map(p => p.number).join()) update(d => { d.physical_pins = numbers.map(number => ({ number })); }); }} /></Box><TextField label="Описание (справочная информация)" size="small" fullWidth value={definition.description ?? ''} onChange={e => update(d => { d.description = e.target.value; })} sx={{ mt: 1.5 }} /></Paper>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center"><TextField select size="small" label="Вариант" value={variantIndex} sx={{ minWidth: 190 }} onChange={e => { setVariantIndex(Number(e.target.value)); setSectionIndex(0); setSelected([]); setPinIndex(null); }}>{definition.variants.map((v, i) => <MenuItem key={v.variant_code} value={i}>{v.variant_code} · {v.name}</MenuItem>)}</TextField><Button onClick={() => { const code = window.prompt('Новый постоянный подкод варианта', String(definition.variants.length + 1).padStart(2, '0')); if (!code) return; if (definition.variants.some(v => v.variant_code === code)) { onNotify('Подкод уже существует.'); return; } update(d => { d.variants.push({ variant_code: code, name: `Вариант ${code}`, sections: [{ section_id: 'BODY', graphics: [], pins: [] }] }); }); setVariantIndex(definition.variants.length); setSectionIndex(0); setSelected([]); setPinIndex(null); }}>+ Вариант</Button><Button color="error" disabled={definition.variants.length < 2} onClick={() => { if (!window.confirm('Удалить выбранный вариант целиком?')) return; update(d => { d.variants.splice(variantIndex, 1); }); setVariantIndex(0); setSectionIndex(0); }}>Удалить вариант</Button><Divider orientation="vertical" flexItem /><TextField select size="small" label="Секция" value={sectionIndex} sx={{ minWidth: 130 }} onChange={e => { setSectionIndex(Number(e.target.value)); setSelected([]); setPinIndex(null); }}>{variant?.sections.map((s, i) => <MenuItem key={s.section_id} value={i}>{s.section_id}</MenuItem>)}</TextField><Button onClick={() => { const id = window.prompt('Постоянный ID секции', `S${variant.sections.length + 1}`); if (!id) return; if (variant.sections.some(s => s.section_id === id)) { onNotify('ID секции уже существует.'); return; } update(d => { d.variants[variantIndex].sections.push({ section_id: id, graphics: [], pins: [] }); }); setSectionIndex(variant.sections.length); setSelected([]); setPinIndex(null); }}>+ Секция</Button><Button color="error" disabled={variant?.sections.length < 2} onClick={() => { if (!window.confirm('Удалить секцию вместе с графикой и точками выводов?')) return; update(d => { d.variants[variantIndex].sections.splice(sectionIndex, 1); }); setSectionIndex(0); setSelected([]); setPinIndex(null); }}>Удалить секцию</Button><TextField size="small" label="Название варианта" value={variant?.name ?? ''} onChange={e => update(d => { d.variants[variantIndex].name = e.target.value; })} /></Stack>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '150px minmax(300px,1fr) 270px' }, gap: 1.5, alignItems: 'start' }}>
      <Paper variant="outlined" sx={{ p: 1, borderRadius: 3 }}><Typography variant="overline" sx={{ px: 1 }}>Инструменты</Typography><Stack gap={.5}>{(Object.keys(toolNames) as Tool[]).map(t => <Button key={t} size="small" variant={tool === t ? 'contained' : 'text'} sx={{ justifyContent: 'flex-start' }} onClick={() => setTool(t)}>{toolNames[t]}</Button>)}</Stack><Divider sx={{ my: 1 }} /><Button fullWidth size="small" onClick={undo} disabled={!past.length}>↶ Отменить</Button><Button fullWidth size="small" onClick={redo} disabled={!future.length}>↷ Повторить</Button><Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, mt: 1 }}>Выравнивание</Typography><Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: .25 }}>{([['left', 'Слева'], ['right', 'Справа'], ['top', 'Сверху'], ['bottom', 'Снизу'], ['horizontal', 'По X'], ['vertical', 'По Y']] as const).map(([edge, label]) => <Button key={edge} size="small" disabled={selected.length < 2} onClick={() => alignSelected(edge)} title={edge === 'horizontal' ? 'Совместить центры по горизонтали' : edge === 'vertical' ? 'Совместить центры по вертикали' : `Выровнять ${label.toLowerCase()}`}>{label}</Button>)}</Box><Button fullWidth size="small" onClick={groupSelected}>В группу</Button><Button fullWidth size="small" disabled={chosen?.kind !== 'group'} onClick={() => { if (!chosen) return; if (chosen.rotation || chosen.mirror) { onNotify('Перед разгруппировкой уберите поворот и отражение группы.'); return; } mutateSection(s => { s.graphics = s.graphics.flatMap(p => p.id === chosen.id ? (p.children ?? []).map(c => movePrimitive(c, p.x ?? 0, p.y ?? 0)) : [p]); }); setSelected([]); }}>Разгруппировать</Button><Button fullWidth size="small" color="error" disabled={!selected.length && pinIndex === null} onClick={removeSelected}>Удалить выбранное</Button></Paper>
      <Paper variant="outlined" sx={{ overflow: 'hidden', borderRadius: 3 }}><Stack direction="row" alignItems="center" gap={1} sx={{ px: 1.5, py: .5, flexWrap: 'wrap' }}><Chip size="small" label={`${variant?.variant_code} / ${section?.section_id}`} /><FormControlLabel control={<Checkbox size="small" checked={snap} onChange={e => setSnap(e.target.checked)} />} label={<Typography variant="caption">Привязка 1,25 мм</Typography>} /><Button size="small" onClick={() => setZoom(z => Math.max(.5, z / 1.25))}>−</Button><Typography variant="caption">{Math.round(zoom * 100)}%</Typography><Button size="small" onClick={() => setZoom(z => Math.min(3, z * 1.25))}>+</Button><Button size="small" onClick={() => setShowPreview(v => !v)}>{showPreview ? 'Редактировать' : 'Предпросмотр'}</Button></Stack>{showPreview ? <Box sx={{ minHeight: 430, bgcolor: '#fff', p: 3, '& svg': { width: '100%', height: 420 } }} dangerouslySetInnerHTML={{ __html: preview }} /> : <Box sx={{ height: 500, overflow: 'auto', bgcolor: '#eef1f7' }}><svg ref={svgRef} viewBox="-30 -30 140 100" fontFamily="OpenGOST type B" style={{ display: 'block', width: `${Math.max(100, zoom * 100)}%`, minWidth: 580 * zoom, minHeight: 430 * zoom, background: 'white', touchAction: 'none', cursor: tool === 'select' ? 'default' : 'crosshair' }} onPointerDown={beginDraw} onPointerMove={move} onPointerUp={endDrag} onPointerCancel={endDrag}><defs><pattern id="component-grid" width="2.5" height="2.5" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r=".10" fill="#b5bed0" /></pattern></defs><rect x="-500" y="-500" width="1500" height="1500" fill="url(#component-grid)" /><path d="M -30 0 H 110 M 0 -30 V 70" stroke="#d8dfeb" strokeWidth=".2" pointerEvents="none" />{section?.graphics.map(p => <PrimitiveShape key={p.id} p={p} selected={selected.includes(p.id)} onDown={e => startDrag(e, p.id)} />)}{section?.pins.map((p, i) => { const length = p.length ?? 5, dx = p.side === 'left' ? length : p.side === 'right' ? -length : 0, dy = p.side === 'top' ? length : p.side === 'bottom' ? -length : 0; return <g key={`${p.number}-${i}`} onPointerDown={e => startDrag(e, '', i)} style={{ cursor: 'move' }}><line x1={p.x} y1={p.y} x2={p.x + dx} y2={p.y + dy} stroke={pinIndex === i ? '#3457d5' : '#18212c'} strokeWidth=".4" /><circle cx={p.x} cy={p.y} r=".8" fill={pinIndex === i ? '#3457d5' : '#fff'} stroke="#3457d5" strokeWidth=".25" /><text x={p.x + 1} y={p.y - 1} fontSize="4.25" fill="#31455f">{p.number}</text></g>; })}</svg></Box>}<Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1.5 }}>Нарисуйте фигуру перетаскиванием. Вывод и текст добавляются щелчком. Ctrl + щелчок — несколько фигур. Координаты относятся к началу секции.</Typography></Paper>
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 3 }}><Typography variant="overline">Свойства</Typography>{chosen ? <Stack gap={1.25}><Chip size="small" label={`${toolNames[chosen.kind]} · ${selected.length > 1 ? `${selected.length} выделено` : chosen.id}`} /><Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>{!['polyline', 'polygon'].includes(chosen.kind) && <>{numericField('X, мм', 'x')}{numericField('Y, мм', 'y')}</>}{chosen.kind === 'line' && <>{numericField('X₂, мм', 'x2')}{numericField('Y₂, мм', 'y2')}</>}{chosen.kind === 'rectangle' && <>{numericField('Ширина, мм', 'width', 10)}{numericField('Высота, мм', 'height', 10)}</>}{['circle', 'arc'].includes(chosen.kind) && numericField('Радиус, мм', 'r', 5)}{chosen.kind === 'arc' && <>{numericField('Начало, °', 'start')}{numericField('Конец, °', 'end', 180)}</>}{<TextField select size="small" label="Поворот, °" value={chosen.rotation ?? 0} onChange={e => setPrimitive('rotation', Number(e.target.value))}>{[0, 90, 180, 270].map(v => <MenuItem key={v} value={v}>{v}°</MenuItem>)}</TextField>}</Box><FormControlLabel control={<Checkbox checked={!!chosen.mirror} onChange={e => setPrimitive('mirror', e.target.checked)} />} label="Отразить по X" />{chosen.kind === 'text' && <><TextField size="small" label="Надпись" value={chosen.text ?? ''} onChange={e => setPrimitive('text', e.target.value)} /><TextField select size="small" label="Выравнивание" value={chosen.align ?? 'left'} onChange={e => setPrimitive('align', e.target.value)}><MenuItem value="left">Слева</MenuItem><MenuItem value="center">По центру</MenuItem><MenuItem value="right">Справа</MenuItem></TextField></>}{['polyline', 'polygon'].includes(chosen.kind) && <><Typography variant="caption">Вершины (мм)</Typography>{chosen.points?.map((a, i) => <Stack key={i} direction="row" gap={.5}><TextField type="number" size="small" label={`X${i + 1}`} value={a.x} onChange={e => { const pts = clone(chosen.points!); pts[i].x = numeric(e.target.value); setPrimitive('points', pts); }} /><TextField type="number" size="small" label={`Y${i + 1}`} value={a.y} onChange={e => { const pts = clone(chosen.points!); pts[i].y = numeric(e.target.value); setPrimitive('points', pts); }} /><Button size="small" disabled={(chosen.points?.length ?? 0) <= (chosen.kind === 'polygon' ? 3 : 2)} onClick={() => setPrimitive('points', chosen.points?.filter((_, j) => i !== j))}>×</Button></Stack>)}<Button size="small" onClick={() => setPrimitive('points', [...(chosen.points ?? []), { x: (chosen.points?.at(-1)?.x ?? 0) + 5, y: chosen.points?.at(-1)?.y ?? 0 }])}>+ Вершина</Button></>}{chosen.kind === 'group' && <Typography variant="caption">Примитивов в группе: {chosen.children?.length ?? 0}. Положение группы задаёт смещение всех её фигур.</Typography>}<Button size="small" onClick={() => { const p = duplicatePrimitive(chosen); const copy = movePrimitive(p, 2.5, 2.5); mutateSection(s => { s.graphics.push(copy); }); setSelected([copy.id]); }}>Дублировать</Button></Stack> : chosenPin ? <Stack gap={1.25}><Typography variant="body2">Физический вывод</Typography><TextField select label="Номер" size="small" value={chosenPin.number} onChange={e => setPin('number', e.target.value)}>{definition.physical_pins.map(p => <MenuItem key={p.number} value={p.number}>{p.number}</MenuItem>)}</TextField><Stack direction="row" gap={1}><TextField type="number" label="X, мм" size="small" value={chosenPin.x} onChange={e => setPin('x', numeric(e.target.value))} /><TextField type="number" label="Y, мм" size="small" value={chosenPin.y} onChange={e => setPin('y', numeric(e.target.value))} /></Stack><TextField select label="Сторона подключения" size="small" value={chosenPin.side} onChange={e => setPin('side', e.target.value)}>{[['left', 'Слева'], ['right', 'Справа'], ['top', 'Сверху'], ['bottom', 'Снизу']].map(([v, label]) => <MenuItem key={v} value={v}>{label}</MenuItem>)}</TextField><TextField type="number" size="small" label="Длина вывода, мм" value={chosenPin.length ?? 5} onChange={e => setPin('length', numeric(e.target.value))} /></Stack> : <Typography variant="body2" color="text.secondary">Выберите фигуру или вывод на поле либо в списке ниже.</Typography>}<Divider sx={{ my: 1.5 }} /><Typography variant="subtitle2">Графика секции</Typography><Stack sx={{ maxHeight: 200, overflow: 'auto' }}>{section?.graphics.map(p => <Button key={p.id} size="small" sx={{ justifyContent: 'flex-start' }} variant={selected.includes(p.id) ? 'contained' : 'text'} onClick={() => { setSelected([p.id]); setPinIndex(null); }}>{toolNames[p.kind]} · {p.kind === 'text' ? p.text : p.id.slice(-6)}</Button>)}</Stack><Typography variant="subtitle2" sx={{ mt: 1 }}>Выводы секции</Typography><Stack direction="row" gap={.5} flexWrap="wrap">{section?.pins.map((p, i) => <Chip key={`${p.number}-${i}`} size="small" label={p.number} color={pinIndex === i ? 'primary' : 'default'} onClick={() => { setPinIndex(i); setSelected([]); }} />)}</Stack><Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Размещено в варианте: {variant?.sections.reduce((n, s) => n + s.pins.length, 0)} из {definition.physical_pins.length}. Каждый номер должен встречаться ровно один раз.</Typography><Button fullWidth sx={{ mt: 1 }} onClick={() => { const found = validateComponent(definition); setIssues(found); if (!found.length) onNotify('Определение прошло проверку.'); }}>Проверить определение</Button></Paper>
    </Box>
    {!!issues.length && <Stack gap={.75}>{issues.slice(0, 30).map((issue, i) => <Alert key={i} severity={issue.severity}>{issue.message}{issue.path && <Typography variant="caption" component="div">{issue.path}</Typography>}</Alert>)}</Stack>}
  </Stack>;
}

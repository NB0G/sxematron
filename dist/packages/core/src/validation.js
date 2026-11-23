import { validateComponentJson, validateSchematicJson } from './generated-validators.js';
export { componentSchema, schematicSchema } from './schemas.js';
const cv = validateComponentJson, sv = validateSchematicJson;
const err = (code, message, path) => ({ severity: 'error', code, message, path });
function duplicates(values, label, path, issues) { const seen = new Set(); for (const s of values) {
    if (seen.has(s))
        issues.push(err('DUPLICATE', `Повтор ${label}: ${s}`, path));
    seen.add(s);
} }
function inputLimits(value) { const stack = [{ value, depth: 0 }], seen = new WeakSet(); let count = 0; while (stack.length) {
    const a = stack.pop();
    if (++count > 250000 || a.depth > 24)
        return [err('LIMIT', 'Превышены размер или глубина JSON')];
    if (a.value && typeof a.value === 'object') {
        if (seen.has(a.value))
            return [err('LIMIT', 'Циклическая структура JSON')];
        seen.add(a.value);
        for (const v of Object.values(a.value))
            stack.push({ value: v, depth: a.depth + 1 });
    }
} return []; }
export function validateComponent(value) {
    const limits = inputLimits(value);
    if (limits.length)
        return limits;
    if (!cv(value))
        return (cv.errors ?? []).map(e => err('SCHEMA', `Компонент ${e.instancePath || '/'}: ${e.message}`, e.instancePath));
    const c = value, issues = [];
    duplicates(c.physical_pins.map(p => p.number), 'номера вывода', 'physical_pins', issues);
    duplicates(c.variants.map(v => v.variant_code), 'подкода', 'variants', issues);
    let graphicCount = 0;
    function primitives(ps, depth, ids) {
        if (depth > 8) {
            issues.push(err('LIMIT', 'Глубина групп примитивов превышает 8'));
            return;
        }
        for (const p of ps) {
            graphicCount++;
            if (ids.has(p.id))
                issues.push(err('DUPLICATE', `Повтор ID примитива ${p.id}`));
            ids.add(p.id);
            const required = { line: ['x', 'y', 'x2', 'y2'], rectangle: ['x', 'y', 'width', 'height'], circle: ['x', 'y', 'r'], arc: ['x', 'y', 'r', 'start', 'end'], polyline: ['points'], polygon: ['points'], text: ['x', 'y', 'text'], group: ['children'] };
            for (const field of required[p.kind])
                if (p[field] === undefined)
                    issues.push(err('PRIMITIVE', `${p.kind} ${p.id}: отсутствует ${field}`));
            if (p.kind === 'polygon' && (p.points?.length ?? 0) < 3)
                issues.push(err('PRIMITIVE', `Многоугольник ${p.id}: нужны минимум 3 вершины`));
            if (p.kind === 'group')
                primitives(p.children ?? [], depth + 1, ids);
        }
    }
    for (const v of c.variants) {
        duplicates(v.sections.map(s => s.section_id), 'секции', v.variant_code, issues);
        const nums = v.sections.flatMap(s => s.pins.map(p => p.number));
        duplicates(nums, 'физического вывода', v.variant_code, issues);
        for (const n of nums)
            if (!c.physical_pins.some(p => p.number === n))
                issues.push(err('PIN', `Вариант ${v.variant_code}: неизвестный вывод ${n}`));
        for (const p of c.physical_pins)
            if (!nums.includes(p.number))
                issues.push(err('PIN', `Вариант ${v.variant_code}: не показан вывод ${p.number}`));
        for (const s of v.sections)
            primitives(s.graphics, 0, new Set());
    }
    if (graphicCount > 20000)
        issues.push(err('LIMIT', 'Слишком много примитивов (максимум 20000)'));
    return issues;
}
export function expandRepeats(input) {
    const s = structuredClone(input), issues = [];
    const total = (s.repeat_instances ?? []).reduce((n, r) => n + r.count * (s.templates?.find(t => t.id === r.template_id)?.components.length ?? 0), s.components.length);
    if (total > 5000)
        return { schematic: s, issues: [err('LIMIT', 'После раскрытия повторов более 5000 компонентов')] };
    for (const repeat of s.repeat_instances ?? []) {
        const t = s.templates?.find(t => t.id === repeat.template_id);
        if (!t) {
            issues.push(err('TEMPLATE', `Нет шаблона ${repeat.template_id}`));
            continue;
        }
        for (let i = 1; i <= repeat.count; i++) {
            const prefix = `${repeat.id}_${i}_`;
            for (const c of t.components) {
                const copy = structuredClone(c);
                copy.id = prefix + c.id;
                copy.tag = repeat.tag ? `${repeat.tag}_${i}` : `${repeat.id}_${i}_${c.tag ?? 'stage'}`;
                delete copy.designator;
                for (const p of Object.values(copy.sections))
                    if (repeat.sheet_id && !p.sheet_id)
                        p.sheet_id = repeat.sheet_id;
                s.components.push(copy);
            }
            for (const net of t.nets)
                s.nets.push({ ...structuredClone(net), id: prefix + net.id, name: net.name ? prefix + net.name : undefined, pins: net.pins.map(p => ({ ...p, instance_id: prefix + p.instance_id })) });
            for (const [port, target] of Object.entries(repeat.connections ?? {})) {
                const pins = t.ports[port], dest = s.nets.find(n => n.id === target);
                if (!pins || !dest) {
                    issues.push(err('PORT', `Повтор ${repeat.id}: порт ${port} или общая цепь ${target} не существует`));
                    continue;
                }
                for (const p of pins) {
                    const term = { ...p, instance_id: prefix + p.instance_id };
                    const local = s.nets.find(n => n.id.startsWith(prefix) && n.pins.some(a => a.instance_id === term.instance_id && a.number === term.number));
                    if (local) {
                        for (const a of local.pins)
                            if (!dest.pins.some(b => b.instance_id === a.instance_id && b.number === a.number))
                                dest.pins.push(a);
                        s.nets = s.nets.filter(n => n !== local);
                    }
                    else if (!dest.pins.some(a => a.instance_id === term.instance_id && a.number === term.number))
                        dest.pins.push(term);
                }
            }
        }
    }
    delete s.templates;
    delete s.repeat_instances;
    return { schematic: s, issues };
}
export function validateSchematic(value, library) {
    const limits = inputLimits(value);
    if (limits.length)
        return limits;
    if (!sv(value))
        return (sv.errors ?? []).map(e => err('SCHEMA', `Схема ${e.instancePath || '/'}: ${e.message}`, e.instancePath));
    const expanded = expandRepeats(value), s = expanded.schematic, issues = [...expanded.issues];
    for (const [label, values] of [['компонента', s.components], ['цепи', s.nets], ['листа', s.sheets], ['группы', s.groups], ['маршрута', s.layout.routes]])
        duplicates(values.map(x => x.id), label, '', issues);
    duplicates(value.templates?.map(t => t.id) ?? [], 'шаблона', 'templates', issues);
    duplicates(value.repeat_instances?.map(r => r.id) ?? [], 'повтора', 'repeat_instances', issues);
    const sheets = new Set(s.sheets.map(a => a.id));
    for (const g of s.groups)
        if (g.sheet_id && !sheets.has(g.sheet_id))
            issues.push(err('SHEET', `Группа ${g.id}: нет листа ${g.sheet_id}`));
    const defs = new Map(library.map(d => [d.component_code, d]));
    const byId = new Map(s.components.map(c => [c.id, c]));
    const used = new Map();
    const des = new Set();
    for (const c of s.components) {
        const def = defs.get(c.component_code);
        if (!def) {
            issues.push(err('COMPONENT', `${c.id}: нет компонента ${c.component_code}`));
            continue;
        }
        const v = def.variants.find(v => v.variant_code === c.variant_code);
        if (!v) {
            issues.push(err('VARIANT', `${c.id}: нет подкода ${c.variant_code}`));
            continue;
        }
        for (const [sid, p] of Object.entries(c.sections)) {
            if (!v.sections.some(a => a.section_id === sid))
                issues.push(err('SECTION', `${c.id}: нет секции ${sid}`));
            if (p.sheet_id && !sheets.has(p.sheet_id))
                issues.push(err('SHEET', `${c.id}/${sid}: нет листа ${p.sheet_id}`));
            if (p.relative && !s.groups.some(g => g.tag === c.tag && g.position))
                issues.push(err('GROUP', `${c.id}: относительные координаты требуют группу с позицией`));
        }
        if (c.designator) {
            if (des.has(c.designator))
                issues.push(err('DESIGNATOR', `Повтор обозначения ${c.designator}`));
            des.add(c.designator);
        }
    }
    for (const n of s.nets) {
        const local = new Set();
        for (const p of n.pins) {
            const c = byId.get(p.instance_id);
            if (!c) {
                issues.push(err('TERMINAL', `${n.id}: нет экземпляра ${p.instance_id}`));
                continue;
            }
            const d = defs.get(c.component_code);
            if (d && !d.physical_pins.some(x => x.number === p.number))
                issues.push(err('PIN', `${n.id}: у ${c.id} нет физического вывода ${p.number}`));
            const key = `${p.instance_id}\0${p.number}`;
            if (local.has(key))
                issues.push(err('DUPLICATE', `${n.id}: вывод ${c.id}.${p.number} указан дважды`));
            local.add(key);
            if (used.has(key) && used.get(key) !== n.id)
                issues.push(err('NET_CONFLICT', `Вывод ${c.id}.${p.number} принадлежит цепям ${used.get(key)} и ${n.id}`));
            used.set(key, n.id);
        }
    }
    for (const r of s.layout.routes) {
        if (!s.nets.some(n => n.id === r.net_id))
            issues.push(err('ROUTE', `Маршрут ${r.id}: нет цепи ${r.net_id}`));
        if (!sheets.has(r.sheet_id))
            issues.push(err('SHEET', `Маршрут ${r.id}: нет листа ${r.sheet_id}`));
        for (let i = 1; i < r.points.length; i++)
            if (r.points[i].x !== r.points[i - 1].x && r.points[i].y !== r.points[i - 1].y)
                issues.push(err('ROUTE', `Маршрут ${r.id}: сегмент ${i} не ортогональный`));
    }
    for (const l of s.layout.labels ?? []) {
        if (!s.nets.some(n => n.id === l.net_id && n.pins.some(p => p.instance_id === l.instance_id && p.number === l.number)))
            issues.push(err('LABEL', `Метка ${l.net_id}: нет соответствующего вывода в цепи`));
    }
    return issues;
}

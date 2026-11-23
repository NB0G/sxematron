const cell = (s) => s.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '\\`');
export function componentCatalog(components) {
    const lines = [
        '# Каталог компонентов', '',
        'Этот документ сформирован из текущей библиотеки SQLite. История определений не хранится.',
        'При ссылке из схемы обязательны `component_code` и `variant_code`. Варианты не подменяются автоматически.',
        'Все секции выбранного варианта должны присутствовать на схеме. Физический вывод определяется номером и ID экземпляра, а не координатами.',
        'Назначения и электрические типы выводов не используются.', '',
        `Количество компонентов: ${components.length}.`, ''
    ];
    for (const c of components) {
        lines.push(`## ${cell(c.component_code)} — ${cell(c.name)}`, '', `Категория: ${cell(c.category)}. Префикс обозначения: ${cell(c.positional_prefix)}.`, '', c.description ? cell(c.description) : '', '', `Физические выводы: ${c.physical_pins.map(p => cell(p.number)).join(', ')}.`, '');
        for (const v of c.variants) {
            lines.push(`### Вариант ${cell(v.variant_code)} — ${cell(v.name)}`, '', '| Секция | Физические номера выводов |', '| --- | --- |');
            for (const s of v.sections)
                lines.push(`| ${cell(s.section_id)} | ${s.pins.map(p => cell(p.number)).join(', ')} |`);
            lines.push('', 'Ссылка экземпляра:', '', '```json', JSON.stringify({ id: 'example_1', component_code: c.component_code, variant_code: v.variant_code, sections: Object.fromEntries(v.sections.map(s => [s.section_id, {}])) }, null, 2), '```', '');
        }
    }
    return lines.join('\n');
}

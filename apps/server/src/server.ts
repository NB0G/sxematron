import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LibraryDatabase } from './database.js';
import { componentCatalog } from './catalog.js';
import { validateComponent, componentSchema, schematicSchema } from '../../../packages/core/src/validation.js';
import type { ComponentDefinition, Issue } from '../../../packages/core/src/types.js';

export type ServerOptions = { dataDir?: string; staticDir?: string; seed?: boolean; projectDir?: string; logger?: boolean };
class ApiError extends Error {
  constructor(readonly statusCode: number, message: string, readonly issues?: Issue[]) { super(message); }
}
function assertComponent(value: unknown): asserts value is ComponentDefinition {
  // Reject pathological nesting before recursive JSON Schema validation.
  const queue: {value:unknown;depth:number}[] = [{value,depth:0}];
  let visited = 0;
  while (queue.length) {
    const current = queue.pop()!;
    if (++visited > 250_000 || current.depth > 24) throw new ApiError(400, 'Превышено допустимое количество полей или глубина JSON.');
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) queue.push({value:child,depth:current.depth+1});
    }
  }
  const issues = validateComponent(value).filter(i => i.severity === 'error');
  if (issues.length) throw new ApiError(400, 'Определение компонента не прошло проверку.', issues);
}

export async function buildServer(options: ServerOptions = {}) {
  const projectDir = options.projectDir ?? process.cwd();
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(projectDir, 'data'));
  const store = new LibraryDatabase(dataDir);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 * 1024, requestTimeout: 30_000 });
  app.addHook('onClose', async () => { store.close(); });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (reply.getHeader('content-type')?.toString().includes('text/html')) {
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    return payload;
  });
  app.setErrorHandler((error: Error & {statusCode?: number; code?: string}, _req, reply) => {
    const status = error instanceof ApiError ? error.statusCode : (error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
    if (status >= 500) app.log.error(error);
    const message = error instanceof ApiError ? error.message : status === 413 ? 'Файл превышает ограничение 10 МиБ.' : status === 400 ? 'Некорректный запрос или JSON.' : status >= 500 ? 'Внутренняя ошибка сервера.' : error.message;
    reply.code(status).send({ message, ...(error instanceof ApiError && error.issues ? {issues:error.issues} : {}) });
  });

  // Initial seed is applied once only. Deleting all components must never re-seed.
  if (options.seed !== false && !store.db.prepare("SELECT value FROM settings WHERE key = 'seed_applied'").get()) {
    const file = path.join(projectDir, 'examples', 'library.json');
    if (existsSync(file)) {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const definitions = Array.isArray(value) ? value : (value as {components?:unknown[]})?.components;
      if (!Array.isArray(definitions)) throw new Error('Некорректная начальная библиотека.');
      definitions.forEach(assertComponent);
      store.transaction(() => {
        for (const definition of definitions as ComponentDefinition[]) {
          if (!store.reserved(definition.component_code)) store.create(definition);
        }
        store.db.prepare("INSERT INTO settings(key, value) VALUES ('seed_applied', '1')").run();
      });
    }
  }

  app.get('/api/health', async () => ({ status:'ok', version:'1.0.0', storage:'library-only' }));
  app.get('/api/components', async () => store.list());
  app.get<{Params:{code:string}}>('/api/components/:code', async req => {
    const component = store.get(req.params.code);
    if (!component) throw new ApiError(404, 'Компонент не найден.');
    return component;
  });
  app.post('/api/components', async (req, reply) => {
    assertComponent(req.body);
    if (store.reserved(req.body.component_code)) throw new ApiError(409, 'Код уже занят или зарезервирован после удаления. Используйте новый код.');
    store.transaction(() => store.create(req.body as ComponentDefinition));
    return reply.code(201).send(req.body);
  });
  app.put<{Params:{code:string}}>('/api/components/:code', async req => {
    assertComponent(req.body);
    if (req.params.code !== req.body.component_code) throw new ApiError(400, 'Постоянный код компонента нельзя изменить.');
    if (!store.get(req.params.code)) throw new ApiError(404, 'Компонент не найден.');
    store.update(req.body);
    return req.body;
  });
  app.delete<{Params:{code:string}}>('/api/components/:code', async (req, reply) => {
    if (!store.get(req.params.code)) throw new ApiError(404, 'Компонент не найден.');
    store.remove(req.params.code);
    return reply.code(204).send();
  });
  app.get('/api/library/export', async (_req, reply) => reply.header('Content-Disposition','attachment; filename="component-library.json"').send({format_version:'1.0',components:store.list(),reserved_codes:store.db.prepare('SELECT code FROM component_codes WHERE code NOT IN (SELECT code FROM components) ORDER BY code').all().map(row=>String(row.code))}));
  app.post('/api/library/import', async req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApiError(400, 'Ожидается объект импорта библиотеки.');
    const body = req.body as {format_version?:string;components?:unknown[];replace?:boolean;reserved_codes?:string[]};
    if (Object.keys(body).some(k => !['format_version','components','replace','reserved_codes'].includes(k)) || !Array.isArray(body.components) || body.components.length > 10_000 || (body.replace !== undefined && typeof body.replace !== 'boolean')) throw new ApiError(400, 'Ожидаются components (до 10000 записей) и replace (логическое значение).');
    if (body.format_version !== undefined && body.format_version !== '1.0') throw new ApiError(400, 'Неизвестная версия формата библиотеки.');
    if (body.reserved_codes !== undefined && (!Array.isArray(body.reserved_codes) || body.reserved_codes.length > 100_000 || body.reserved_codes.some(code=>typeof code !== 'string' || code.length > 100 || !/^[A-Za-z0-9_:.~-]+$/.test(code)))) throw new ApiError(400, 'Некорректный список зарезервированных кодов.');
    body.components.forEach(assertComponent);
    const definitions = body.components as ComponentDefinition[];
    const seen = new Set<string>();
    let added = 0, replaced = 0, skipped = 0;
    for (const c of definitions) {
      if (seen.has(c.component_code)) throw new ApiError(400, `Код ${c.component_code} повторяется в импортируемой библиотеке.`);
      seen.add(c.component_code);
      const existing = store.get(c.component_code);
      if (!existing && store.reserved(c.component_code)) throw new ApiError(409, `Код ${c.component_code} зарезервирован после удаления и не может использоваться повторно.`);
      if (existing && !isDeepStrictEqual(existing, c) && !body.replace) throw new ApiError(409, `Компонент ${c.component_code} отличается от текущего. Для явной замены повторите импорт с replace: true.`);
    }
    for (const code of body.reserved_codes ?? []) {
      if (seen.has(code) || store.get(code)) throw new ApiError(409, `Зарезервированный удалённый код ${code} конфликтует с действующим компонентом.`);
    }
    store.transaction(() => {
      for (const code of body.reserved_codes ?? []) store.db.prepare('INSERT OR IGNORE INTO component_codes(code) VALUES (?)').run(code);
      for (const c of definitions) {
        const existing = store.get(c.component_code);
        if (!existing) {store.create(c); added++;}
        else if (isDeepStrictEqual(existing, c)) skipped++;
        else {store.update(c); replaced++;}
      }
    });
    return { added, replaced, skipped };
  });
  app.get('/api/library/backup.sqlite', async (_req, reply) => {
    const file = path.join(dataDir, `backup-${randomUUID()}.sqlite`);
    try {
      // VACUUM INTO produces a transactionally consistent copy including WAL content.
      const escaped = file.replace(/'/g, "''");
      store.db.exec(`VACUUM INTO '${escaped}'`);
      return reply.header('Content-Disposition','attachment; filename="library-backup.sqlite"').type('application/vnd.sqlite3').send(readFileSync(file));
    } finally { if (existsSync(file)) unlinkSync(file); }
  });
  app.get<{Params:{name:string}}>('/api/docs/:name', async (req, reply) => {
    const name = req.params.name;
    if (name === 'COMPONENT_CATALOG.md') return reply.type('text/markdown; charset=utf-8').send(componentCatalog(store.list()));
    if (!['SCHEMATIC_AI.md','COMPONENT_BUILDER_AI.md'].includes(name)) throw new ApiError(404,'Документ не найден.');
    const file = path.join(projectDir,'docs',name);
    if (!existsSync(file)) throw new ApiError(404,'Документ отсутствует в сборке.');
    return reply.type('text/markdown; charset=utf-8').send(readFileSync(file,'utf8'));
  });
  app.get('/api/schemas/component.json', async () => componentSchema);
  app.get('/api/schemas/schematic.json', async () => schematicSchema);
  app.get<{Params:{name:string}}>('/api/examples/:name', async (req, reply) => {
    const folder = path.join(projectDir,'examples');
    if (!existsSync(folder) || !readdirSync(folder).includes(req.params.name) || !req.params.name.endsWith('.json')) throw new ApiError(404,'Пример не найден.');
    return reply.type('application/json').send(readFileSync(path.join(folder,req.params.name),'utf8'));
  });

  const staticDir = path.resolve(options.staticDir ?? path.join(projectDir,'dist','web'));
  if (existsSync(path.join(staticDir,'index.html'))) {
    await app.register(fastifyStatic, { root:staticDir, maxAge:'1h', index:['index.html'] });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !existsSync(path.join(staticDir,'index.html'))) return reply.code(404).send({message:'Ресурс не найден.'});
    if (req.method !== 'GET') return reply.code(404).send({message:'Ресурс не найден.'});
    return reply.type('text/html').send(readFileSync(path.join(staticDir,'index.html')));
  });
  return app;
}

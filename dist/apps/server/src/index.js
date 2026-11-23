import { buildServer } from './server.js';
const app = await buildServer({ logger: true });
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => { void app.close().then(() => process.exit(0), () => process.exit(1)); });

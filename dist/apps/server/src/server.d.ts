import Fastify from 'fastify';
export type ServerOptions = {
    dataDir?: string;
    staticDir?: string;
    seed?: boolean;
    projectDir?: string;
    logger?: boolean;
};
export declare function buildServer(options?: ServerOptions): Promise<Fastify.FastifyInstance<import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, Fastify.FastifyBaseLogger, Fastify.FastifyTypeProviderDefault>>;

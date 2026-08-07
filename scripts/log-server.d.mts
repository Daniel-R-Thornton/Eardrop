import type { Server } from 'node:http';
export function createLogServer(opts: { rootDir: string; distDir: string }): Server;

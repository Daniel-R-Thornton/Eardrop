import type { IncomingMessage, ServerResponse } from 'node:http';
export function handleLogRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { rootDir: string },
): Promise<boolean>;

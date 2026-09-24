import type { IncomingMessage, ServerResponse } from 'node:http';

export type VercelRequest = IncomingMessage & { body?: unknown };
export interface VercelResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
}

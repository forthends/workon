import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Delivery } from './delivery.js';
import { WorkonError } from './errors.js';
import type { InboxItem } from './types.js';

type ClientInfo = { id: 'qoder' | 'cursor'; command: string; online: boolean };

export function createHttpServer(deps: {
  delivery: Delivery;
  discover(): Promise<ClientInfo[]>;
  listInbox(): InboxItem[];
}): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkonError(400, 'invalid', 'JSON 无法解析');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkonError) throw error;
    throw new WorkonError(400, 'invalid', 'JSON 无法解析');
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendWorkonError(res: ServerResponse, error: WorkonError): void {
  sendJson(res, error.statusCode, { error: error.error, message: error.message, status: error.requirementStatus });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found', message: '路径不存在' });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { delivery: Delivery; discover(): Promise<ClientInfo[]>; listInbox(): InboxItem[] },
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const needsBody = method === 'POST';
    const body = needsBody ? parseBody(await readBody(req)) : {};

    if (parts.length === 1 && parts[0] === 'inbox' && method === 'GET') {
      sendJson(res, 200, { items: deps.listInbox() });
      return;
    }

    if (parts.length === 1 && parts[0] === 'clients' && method === 'GET') {
      sendJson(res, 200, { clients: await deps.discover() });
      return;
    }

    if (parts[0] !== 'requirements') {
      notFound(res);
      return;
    }

    if (parts.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, deps.delivery.list());
        return;
      }
      if (method === 'POST') {
        const text = typeof body.text === 'string' ? body.text : '';
        const created = deps.delivery.submit(text);
        sendJson(res, 201, created);
        return;
      }
      notFound(res);
      return;
    }

    if (parts.length === 2 && method === 'GET') {
      sendJson(res, 200, deps.delivery.get(parts[1]));
      return;
    }

    if (parts.length === 3 && method === 'POST') {
      const id = parts[1];
      const action = parts[2];
      if (action === 'accept') {
        sendJson(res, 200, deps.delivery.accept(id));
        return;
      }
      if (action === 'reject') {
        const comment = typeof body.comment === 'string' ? body.comment : '';
        sendJson(res, 200, deps.delivery.reject(id, comment));
        return;
      }
      if (action === 'supplement') {
        const text = typeof body.text === 'string' ? body.text : '';
        sendJson(res, 200, deps.delivery.supplement(id, text));
        return;
      }
      if (action === 'retry') {
        sendJson(res, 200, deps.delivery.retry(id));
        return;
      }
    }

    notFound(res);
  } catch (error) {
    if (error instanceof WorkonError) {
      sendWorkonError(res, error);
      return;
    }
    throw error;
  }
}

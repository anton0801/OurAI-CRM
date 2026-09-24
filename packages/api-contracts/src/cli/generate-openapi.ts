/**
 * Generates `docs/api/openapi.json` (OpenAPI 3.1) from the zod endpoint contracts — the same
 * definitions the server router validates against and the typed client is built from.
 *   pnpm openapi:generate [--out path] [--check]
 * `--check` fails when the committed document is out of date (used in CI).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ERROR_HTTP_STATUS } from '@castlane/domain';
import { ENDPOINT_GROUPS } from '../registry';
import type { AnyEndpoint } from '../core';

type JsonSchema = Record<string, unknown>;

const toSchema = (s: z.ZodTypeAny, io: 'input' | 'output'): JsonSchema => {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as JsonSchema;
  delete out.$schema;
  return out;
};

const objectProperties = (s: z.ZodTypeAny) => {
  const js = toSchema(s, 'input');
  const props = (js.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((js.required ?? []) as string[]);
  return Object.entries(props).map(([name, schema]) => ({ name, schema, required: required.has(name) }));
};

const errorResponse = {
  description: 'Error envelope',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string', enum: Object.keys(ERROR_HTTP_STATUS) },
              message: { type: 'string' },
              requestId: { type: 'string' },
              fieldErrors: {
                type: 'array',
                items: { type: 'object', properties: { field: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } },
              },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
};

const operation = (e: AnyEndpoint) => {
  const parameters: JsonSchema[] = [];
  for (const p of objectProperties(e.params)) parameters.push({ name: p.name, in: 'path', required: true, schema: p.schema });
  for (const p of objectProperties(e.query)) parameters.push({ name: p.name, in: 'query', required: p.required, schema: p.schema });
  if (e.idempotent)
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Replays return the stored response; a different body with the same key is rejected.' });
  if (e.ifMatch)
    parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' }, description: 'Row version from the last read (428 when missing, 412 when stale).' });
  if (e.method !== 'GET' && e.auth !== 'public')
    parameters.push({ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } });

  const bodyProps = objectProperties(e.body);
  const hasBody = e.method !== 'GET' && e.method !== 'DELETE' && bodyProps.length > 0;
  const status = String(e.successStatus ?? (e.method === 'POST' ? 201 : 200));
  const errorCodes = new Set<string>(['400', '401', '403', '404', '429', '500']);
  if (e.idempotent) errorCodes.add('409');
  if (e.ifMatch) (errorCodes.add('412'), errorCodes.add('428'));
  if (hasBody) errorCodes.add('422');
  for (const c of e.errors ?? []) errorCodes.add(String(ERROR_HTTP_STATUS[c]));

  return {
    operationId: e.id,
    summary: e.summary,
    tags: e.tags,
    security: e.auth === 'public' ? [] : [{ session: [] }],
    'x-permission': e.permission,
    'x-auth': e.auth,
    parameters,
    ...(hasBody ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(e.body, 'input') } } } } : {}),
    responses: {
      [status]: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['data', 'meta'],
              properties: {
                data: toSchema(e.response, 'output'),
                meta: { type: 'object', properties: { requestId: { type: 'string' }, asOf: { type: 'string', format: 'date-time' }, nextCursor: { type: ['string', 'null'] }, hasMore: { type: 'boolean' }, replayed: { type: 'boolean' } } },
              },
            },
          },
        },
      },
      ...Object.fromEntries([...errorCodes].sort().map((c) => [c, { $ref: '#/components/responses/Error' }])),
    },
  };
};

export const buildOpenApi = () => {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const group of Object.values(ENDPOINT_GROUPS))
    for (const e of Object.values(group)) {
      if (seen.has(e.id)) throw new Error(`Duplicate endpoint id ${e.id}`);
      seen.add(e.id);
      const method = e.method.toLowerCase();
      paths[e.path] ??= {};
      if (paths[e.path]![method]) throw new Error(`Duplicate route ${e.method} ${e.path}`);
      paths[e.path]![method] = operation(e);
    }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Castlane CRM API',
      version: '1.0.0',
      description:
        'Internal REST API of Castlane CRM. All paths are relative to /api/v1. Session cookie authentication; state-changing requests need the X-CSRF-Token header and a same-origin Origin. Responses use the {data, meta} envelope; errors use {error}.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'castlane_session' } },
      responses: { Error: errorResponse },
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
};

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('generate-openapi.ts');
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = resolve(outIdx >= 0 ? args[outIdx + 1]! : 'docs/api/openapi.json');
  const doc = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(out, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== doc) {
      console.error(`${out} is out of date. Run pnpm openapi:generate.`);
      process.exit(1);
    }
    console.log('OpenAPI document is up to date.');
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, doc);
    const ops = Object.values(buildOpenApi().paths).reduce((n, p) => n + Object.keys(p).length, 0);
    console.log(`Wrote ${out} (${ops} operations).`);
  }
}

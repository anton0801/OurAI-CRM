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

/** Recursive schemas (zod emits them as local $defs) live in components.schemas, shared by content. */
const recursiveDefs = new Map<string, { name: string; schema: JsonSchema }>();

const rewriteRefs = (node: unknown, map: Map<string, string>): unknown => {
  if (Array.isArray(node)) return node.map((x) => rewriteRefs(x, map));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && map.has(v) ? map.get(v) : rewriteRefs(v, map)]));
};

const toSchema = (s: z.ZodTypeAny, io: 'input' | 'output'): JsonSchema => {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as JsonSchema;
  delete out.$schema;
  const defs = out.$defs as Record<string, JsonSchema> | undefined;
  if (!defs) return out;
  delete out.$defs;
  const map = new Map<string, string>();
  for (const [local, def] of Object.entries(defs)) {
    const key = `${io}:${JSON.stringify(def)}`;
    let entry = recursiveDefs.get(key);
    if (!entry) {
      entry = { name: `Recursive${recursiveDefs.size + 1}`, schema: def };
      recursiveDefs.set(key, entry);
    }
    map.set(`#/$defs/${local}`, `#/components/schemas/${entry.name}`);
  }
  for (const e of recursiveDefs.values()) e.schema = rewriteRefs(e.schema, map) as JsonSchema;
  return rewriteRefs(out, map) as JsonSchema;
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

const isSchemaNode = (v: unknown): v is JsonSchema =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (typeof (v as JsonSchema).type === 'string' || Array.isArray((v as JsonSchema).type) || 'anyOf' in v || 'oneOf' in v || 'allOf' in v || 'enum' in v);

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');

/**
 * Repeated sub-schemas (member references, money, value envelopes, list items …) move to
 * components.schemas and are referenced with $ref, named after their first use
 * (operation + property path). Keeps the document readable instead of inlining every copy.
 */
const hoistSharedSchemas = (paths: Record<string, Record<string, unknown>>) => {
  const MIN_SIZE = 160;
  const counts = new Map<string, number>();
  const firstUse = new Map<string, string>();
  const count = (node: unknown, where: string) => {
    if (Array.isArray(node)) return node.forEach((x) => count(x, where));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) count(v, k === 'properties' || k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'additionalProperties' ? where : `${where} ${k}`);
    if (isSchemaNode(node)) {
      const key = JSON.stringify(node);
      if (key.length < MIN_SIZE) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!firstUse.has(key)) firstUse.set(key, where);
    }
  };
  for (const ops of Object.values(paths)) for (const op of Object.values(ops)) count(op, (op as { operationId: string }).operationId);

  const schemas: Record<string, JsonSchema> = {};
  const names = new Map<string, string>();
  const used = new Set<string>();
  const nameFor = (key: string) => {
    let name = names.get(key);
    if (name) return name;
    const words = firstUse.get(key)!.split(' ');
    const base = pascal([words[0]!, ...words.slice(1).filter((w) => !['requestBody', 'responses', 'content', 'application/json', 'schema', 'data', 'parameters'].includes(w) && !/^\d+$/.test(w)).slice(-2)].join(' ')) || 'Schema';
    name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    names.set(key, name);
    return name;
  };
  const replace = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(replace);
    if (!node || typeof node !== 'object') return node;
    if (isSchemaNode(node)) {
      const key = JSON.stringify(node);
      if ((counts.get(key) ?? 0) >= 2) {
        const name = nameFor(key);
        if (!schemas[name]) {
          schemas[name] = {};
          schemas[name] = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v)])) as JsonSchema;
        }
        return { $ref: `#/components/schemas/${name}` };
      }
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v)]));
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(paths)) out[path] = replace(ops) as Record<string, unknown>;
  return { paths: out, schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) };
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
  const hoisted = hoistSharedSchemas(Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Castlane CRM API',
      license: { name: 'Proprietary, internal use only' },
      version: '1.0.0',
      description:
        'Internal REST API of Castlane CRM. All paths are relative to /api/v1. Session cookie authentication; state-changing requests need the X-CSRF-Token header and a same-origin Origin. Responses use the {data, meta} envelope; errors use {error}.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'castlane_session' } },
      responses: { Error: errorResponse },
      schemas: { ...hoisted.schemas, ...Object.fromEntries([...recursiveDefs.values()].map((d) => [d.name, d.schema])) },
    },
    paths: hoisted.paths,
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

import { z } from 'zod';
import { defineTool, EditorTool } from '../harness/tool';
import { API_ADAPTERS, API_SOURCE_NAMES, AdapterContextDeps, ApiAdapterError, makeAdapterContext, redactSecrets } from './api-adapters';

export type ApiToolDeps = AdapterContextDeps;

/** fetch_api (spec 009 T001): typed adapters over the public APIs the legacy strategies used. */
export function buildApiTools(d: ApiToolDeps): EditorTool[] {
  const ctx = makeAdapterContext(d);

  const fetchApi = defineTool({
    name: 'fetch_api',
    description: [
      'Отримати свіжі дані з публічного API (без ключів у відповіді). Повертає {items:[{title, summary, url, image, date, extra}]}.',
      'Джерела (source → params):',
      ...API_SOURCE_NAMES.map((n) => `• ${API_ADAPTERS[n].description}`),
      'Тексти здебільшого англійською — перекладай і переказуй своїми словами; url — це source.url для PostSpec.',
    ].join('\n'),
    kind: 'read', roles: ['planner', 'executor', 'reviewer'],
    input: z.object({
      source: z.enum(API_SOURCE_NAMES),
      params: z.record(z.string(), z.unknown()).default({}).describe('Параметри джерела (див. опис); {} — типові'),
    }),
    execute: async ({ source, params }) => {
      const adapter = API_ADAPTERS[source];
      const p = adapter.params.safeParse(params ?? {});
      if (!p.success) {
        return { error: 'invalid_params', details: p.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`) };
      }
      try {
        const res = await adapter.fetch(p.data, ctx);
        return { source, ...res };
      } catch (err: any) {
        if (err instanceof ApiAdapterError) return { error: err.code, details: redactSecrets(err.message) };
        return { error: 'fetch_failed', details: redactSecrets(String(err?.message ?? err)) };
      }
    },
  });

  return [fetchApi];
}

import { z } from 'zod';
import { decodeJsonStrings, dropPlaceholders } from '../harness/agent-loop';
import type { ToolError } from '../harness/tool';

/**
 * Spec 053 FR-001: the full PostSpec JSON schema (~16k characters) went to the model three times on every step —
 * publish_post, lint_post and preview_post. Now only the terminal tool carries it; the check tools take the same object
 * without a schema and validate it here, with the loop's repairs (placeholders, objects sent as JSON strings).
 */
export function specRefInput(where: string) {
  return z.object({
    spec: z.record(z.string(), z.unknown()).describe(`Пост у тій самій формі, що й spec у ${where} (схема — там).`),
  });
}

/** Validate a schemaless spec argument; the same `invalid_args` error the loop returns for a schema miss. */
export function parseSpecArg<T>(schema: z.ZodType<T>, raw: unknown): { spec: T } | ToolError {
  let parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const repaired = dropPlaceholders(decodeJsonStrings(raw));
    if (repaired !== raw) {
      const again = schema.safeParse(repaired);
      if (again.success) parsed = again;
    }
  }
  if (!parsed.success) {
    return { error: 'invalid_args', details: parsed.error.issues.map((i) => ({ path: ['spec', ...i.path].join('.'), message: i.message })) };
  }
  return { spec: parsed.data };
}

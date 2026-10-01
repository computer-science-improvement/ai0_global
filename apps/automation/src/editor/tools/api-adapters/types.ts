import type { z } from 'zod';

/** Compact, source-independent item every adapter returns to the model. */
export interface ApiItem {
  title:   string;
  summary: string | null;
  url:     string | null;
  image:   string | null;
  date:    string | null;
  extra?:  Record<string, unknown>;
}

export interface ApiResult {
  items: ApiItem[];
  /** Short hint for the model (e.g. "today's APOD is a video"). */
  note?: string;
}

export type Query = Record<string, string | number | boolean | undefined>;

/** What an adapter may do: JSON GETs through the SSRF-guarded HTTP layer, read env, know the time. */
export interface AdapterContext {
  getJson(url: string, query?: Query): Promise<any>;
  env(key: string): string | undefined;
  now(): Date;
}

export interface ApiAdapter<S extends z.ZodType = z.ZodType> {
  name:        string;
  /** One line for the tool description: what it returns and its params. */
  description: string;
  params:      S;
  fetch(params: z.infer<S>, ctx: AdapterContext): Promise<ApiResult>;
}

/** An expected, explainable failure (missing key, upstream HTTP error) returned to the model as {error, details}. */
export class ApiAdapterError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const clipAt = 500;
export const clip = (s: unknown, n = clipAt): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function defineAdapter<S extends z.ZodType>(a: ApiAdapter<S>): ApiAdapter<S> {
  return a;
}

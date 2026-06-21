import { createHash, timingSafeEqual } from 'crypto';

/** LiqPay signature: base64(sha1(private + data + private)). */
export function sign(data: string, privateKey: string): string {
  return createHash('sha1').update(privateKey + data + privateKey).digest('base64');
}

export function encodeData(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params)).toString('base64');
}

export function decodeData<T = any>(data: string): T {
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as T;
}

export function verify(data: string, signature: string, privateKey: string): boolean {
  const expected = sign(data, privateKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

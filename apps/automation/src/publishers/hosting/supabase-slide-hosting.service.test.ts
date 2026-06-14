import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseSlideHostingService } from './supabase-slide-hosting.service';

// Minimal ConfigService stand-in.
function fakeConfig(vars: Record<string, string | undefined>) {
  return { get: (k: string) => vars[k] } as any;
}

const FULL_ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  SUPABASE_CAROUSEL_BUCKET: 'carousel',
};

// A fake "storage.from(bucket)" object recording calls.
function fakeStorage(opts: { uploadError?: (i: number) => string | null; removeError?: string } = {}) {
  const calls: any = { uploads: [], publicUrls: [], removes: [] };
  let uploadCount = 0;
  const storage = {
    upload: async (path: string, body: Buffer, options: any) => {
      const i = uploadCount++;
      calls.uploads.push({ path, body, options });
      const err = opts.uploadError ? opts.uploadError(i) : null;
      return err ? { data: null, error: { message: err } } : { data: { path }, error: null };
    },
    getPublicUrl: (path: string) => {
      calls.publicUrls.push(path);
      return { data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/carousel/${path}` } };
    },
    remove: async (paths: string[]) => {
      calls.removes.push(paths);
      return opts.removeError ? { data: null, error: { message: opts.removeError } } : { data: [], error: null };
    },
  };
  return { storage, calls };
}

// Subclass that injects the fake storage instead of a real Supabase client.
class TestService extends SupabaseSlideHostingService {
  bucketArg?: string;
  constructor(env: any, private readonly fake: any) { super(env); }
  protected getStorage(bucket: string) { this.bucketArg = bucket; return this.fake; }
}

test('available() is true only when all three env vars are set', async () => {
  assert.equal(await new SupabaseSlideHostingService(fakeConfig(FULL_ENV)).available(), true);
  assert.equal(await new SupabaseSlideHostingService(fakeConfig({ ...FULL_ENV, SUPABASE_SERVICE_KEY: undefined })).available(), false);
  assert.equal(await new SupabaseSlideHostingService(fakeConfig({})).available(), false);
});

test('upload() stores each slide and returns urls+paths in order', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  const slides = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];

  const result = await svc.upload(slides, 'carousel/r1/abc');

  assert.equal(calls.uploads.length, 3);
  assert.deepEqual(calls.uploads.map((u: any) => u.path), [
    'carousel/r1/abc/slide-1.png',
    'carousel/r1/abc/slide-2.png',
    'carousel/r1/abc/slide-3.png',
  ]);
  assert.equal(calls.uploads[0].body, slides[0]);
  assert.deepEqual(calls.uploads[0].options, { contentType: 'image/png', upsert: true });
  assert.deepEqual(result.map(r => r.path), [
    'carousel/r1/abc/slide-1.png',
    'carousel/r1/abc/slide-2.png',
    'carousel/r1/abc/slide-3.png',
  ]);
  assert.match(result[2].url, /slide-3\.png$/);
  assert.equal(svc.bucketArg, 'carousel');
  assert.deepEqual(calls.publicUrls, [
    'carousel/r1/abc/slide-1.png',
    'carousel/r1/abc/slide-2.png',
    'carousel/r1/abc/slide-3.png',
  ]);
});

test('upload() throws with the slide index when a slide fails', async () => {
  const { storage } = fakeStorage({ uploadError: (i) => (i === 1 ? 'boom' : null) });
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await assert.rejects(
    () => svc.upload([Buffer.from('a'), Buffer.from('b')], 'carousel/r1/abc'),
    /slide 2.*boom/i,
  );
});

test('upload() throws when not configured', async () => {
  const svc = new SupabaseSlideHostingService(fakeConfig({}));
  await assert.rejects(() => svc.upload([Buffer.from('a')], 'carousel/r1/abc'), /not configured/i);
});

test('delete() forwards paths to storage.remove', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete(['carousel/r1/abc/slide-1.png', 'carousel/r1/abc/slide-2.png']);
  assert.deepEqual(calls.removes, [['carousel/r1/abc/slide-1.png', 'carousel/r1/abc/slide-2.png']]);
});

test('delete() resolves (no throw) when removal errors', async () => {
  const { storage } = fakeStorage({ removeError: 'nope' });
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete(['x']); // must not reject
});

test('delete() no-ops on empty input', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete([]);
  assert.equal(calls.removes.length, 0);
});

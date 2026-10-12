import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { S3BookStorage, type BookStorage } from '../src/books/storage.js';

const id = '9146a916-a99e-4917-89a3-207f20c1b47e';
const base = `recordings/cd208cb3-9c1a-4653-84a4-708de78e682e/Books/${id}`;
const chapter = {
  id: 'recording-5',
  sourceLanguage: 'hi',
  audioKey: `${base}/original.mp3`,
  summaryKey: `${base}/summary.txt`,
  refinedStoryKey: `${base}/manuscript.txt`,
  englishTranslationKey: `${base}/manuscript.en.txt`,
  images: [] as Array<{ key: string; alt: string }>,
};
function manifest() {
  return { schemaVersion: 1, title: 'Daddy’s Story', chapters: [structuredClone(chapter)] };
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(data: unknown = manifest()) {
  const files = new Map([
    [`books/${id}/book.json`, JSON.stringify(data)],
    [chapter.summaryKey, 'A childhood memory.'],
    [chapter.refinedStoryKey, 'मेरी कहानी।'],
    [chapter.englishTranslationKey, 'My story.'],
  ]);
  const storage: BookStorage = {
    exists: vi.fn(async (key) => key === chapter.audioKey || files.has(key)),
    readText: vi.fn(async (key) => {
      const value = files.get(key);
      if (value === undefined) throw new AppError(404, 'BOOK_CONTENT_NOT_FOUND', 'Unavailable');
      return value;
    }),
    signMedia: vi.fn(async () => ({
      url: 'https://media.example.test/audio',
      expiresAt: '2026-10-06T20:00:00Z',
    })),
  };
  const app = await buildApp({ bookStorage: storage });
  apps.push(app);
  return { app, storage, files };
}

describe('public book reader', () => {
  it('resolves the canonical manifest, preserves chapter order, and exposes no object keys', async () => {
    const m = manifest();
    m.chapters.push({ ...chapter, id: 'recording-22' });
    const { app, storage } = await setup(m);
    const result = await app.inject(`/api/v1/books/${id}`);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      title: 'Daddy’s Story',
      chapters: [
        { id: 'recording-5', number: 1, summary: 'A childhood memory.' },
        { id: 'recording-22', number: 2 },
      ],
    });
    expect(storage.readText).toHaveBeenCalledWith(`books/${id}/book.json`);
    expect(result.body).not.toContain(base);
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('returns Hindi and English text by explicit reading version', async () => {
    const { app } = await setup();
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?version=original`)).json(),
    ).toMatchObject({ text: 'मेरी कहानी।', language: 'hi', number: 1 });
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?version=english`)).json(),
    ).toMatchObject({ text: 'My story.', language: 'en' });
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?version=other`)).statusCode,
    ).toBe(400);
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?key=private`)).statusCode,
    ).toBe(400);
  });
  it('only signs the selected chapter audio and manifest image references', async () => {
    const m = manifest();
    m.chapters[0]!.images = [{ key: `books/${id}/images/photo.jpg`, alt: 'Family home' }];
    const { app, storage } = await setup(m);
    const audio = await app.inject(`/api/v1/books/${id}/chapters/recording-5/audio?key=private`);
    expect(audio.statusCode).toBe(200);
    expect(storage.signMedia).toHaveBeenCalledWith(chapter.audioKey);
    expect(storage.signMedia).not.toHaveBeenCalledWith('private');
    const reading = await app.inject(`/api/v1/books/${id}/chapters/recording-5`);
    expect(reading.json().images[0].alt).toBe('Family home');
    expect(storage.signMedia).toHaveBeenCalledWith(`books/${id}/images/photo.jpg`);
  });
  it('rejects invalid IDs, missing books and unknown chapters without signing media', async () => {
    const { app, storage } = await setup();
    expect((await app.inject('/api/v1/books/invalid')).statusCode).toBe(404);
    expect(storage.readText).not.toHaveBeenCalled();
    expect(
      (await app.inject('/api/v1/books/11111111-1111-4111-8111-111111111111')).statusCode,
    ).toBe(404);
    expect((await app.inject(`/api/v1/books/${id}/chapters/unknown/audio`)).statusCode).toBe(404);
    expect(storage.signMedia).not.toHaveBeenCalled();
  });
  it.each([
    '../secret',
    `${base}/../secret`,
    'books/other/secret',
    'recordings/owner/private.txt',
    'https://evil.test/audio',
  ])('rejects unsafe/cross-book reference %s', async (key) => {
    const m = manifest();
    m.chapters[0]!.audioKey = key;
    const { app, storage } = await setup(m);
    expect((await app.inject(`/api/v1/books/${id}`)).statusCode).toBe(502);
    expect(storage.readText).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed JSON, duplicate chapter IDs and unsupported versions', async () => {
    const { app, files } = await setup();
    for (const text of [
      '{',
      JSON.stringify({ ...manifest(), schemaVersion: 2 }),
      JSON.stringify({ ...manifest(), chapters: [chapter, chapter] }),
    ]) {
      files.set(`books/${id}/book.json`, text);
      expect((await app.inject(`/api/v1/books/${id}`)).statusCode).toBe(502);
    }
  });
  it('keeps chapters readable when a summary is missing, and returns 404 for missing text', async () => {
    const { app, files } = await setup();
    files.delete(chapter.summaryKey);
    expect((await app.inject(`/api/v1/books/${id}`)).json().chapters[0].summary).toBeNull();
    files.delete(chapter.refinedStoryKey);
    expect((await app.inject(`/api/v1/books/${id}/chapters/recording-5`)).statusCode).toBe(404);
  });
  it('handles English originals without duplicate translation, and absent translations', async () => {
    const m = {
      ...manifest(),
      chapters: [{ ...chapter, sourceLanguage: 'en', englishTranslationKey: null }],
    };
    const { app, files } = await setup(m);
    expect((await app.inject(`/api/v1/books/${id}`)).json().chapters[0].hasEnglishTranslation).toBe(
      false,
    );
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?version=english`)).statusCode,
    ).toBe(200);
    m.chapters[0]!.sourceLanguage = 'hi';
    files.set(`books/${id}/book.json`, JSON.stringify(m));
    expect(
      (await app.inject(`/api/v1/books/${id}/chapters/recording-5?version=english`)).statusCode,
    ).toBe(404);
  });
});

describe('book availability', () => {
  it('returns both summaries and checks actual files', async () => {
    const m = manifest();
    const data = {
      ...m,
      chapters: [{ ...chapter, originalSummaryKey: `${base}/summary.original.txt` }],
    };
    const { app, files, storage } = await setup(data);
    files.set(`${base}/summary.original.txt`, 'घर की यादें।');
    files.delete(chapter.englishTranslationKey);
    const response = await app.inject(`/api/v1/books/${id}`);
    expect(response.json().chapters[0]).toMatchObject({
      originalSummary: 'घर की यादें।',
      summary: 'A childhood memory.',
      hasAudio: true,
      hasRefinedStory: true,
      hasEnglishTranslation: false,
    });
    expect(storage.exists).toHaveBeenCalledWith(chapter.englishTranslationKey);
    const reading = await app.inject(`/api/v1/books/${id}/chapters/recording-5`);
    expect(reading.json().hasEnglishTranslation).toBe(false);
  });
  it('accepts absent/null references and reports unavailable without accessing arbitrary objects', async () => {
    const { app, storage } = await setup({
      schemaVersion: 1,
      title: 'Partial book',
      chapters: [{ id: 'empty', sourceLanguage: 'hi', summaryKey: null }],
    });
    const result = await app.inject(`/api/v1/books/${id}`);
    expect(result.statusCode).toBe(200);
    expect(result.json().chapters[0]).toMatchObject({
      summary: null,
      originalSummary: null,
      hasAudio: false,
      hasRefinedStory: false,
      hasEnglishTranslation: false,
    });
    expect(storage.exists).not.toHaveBeenCalled();
    expect((await app.inject(`/api/v1/books/${id}/chapters/empty/audio`)).statusCode).toBe(404);
  });
  it('keeps transient failures retryable instead of reporting missing content', async () => {
    const { app, storage } = await setup();
    vi.mocked(storage.exists).mockRejectedValue(
      new AppError(503, 'BOOK_STORAGE_UNAVAILABLE', 'Try again'),
    );
    expect((await app.inject(`/api/v1/books/${id}`)).statusCode).toBe(503);
  });
  it('distinguishes missing/empty objects from S3 access failures', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: 100 })
      .mockResolvedValueOnce({ ContentLength: 0 })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });
    const storage = new S3BookStorage({ send } as unknown as S3Client, 'test');
    expect(await storage.exists('present')).toBe(true);
    expect(await storage.exists('empty')).toBe(false);
    expect(await storage.exists('missing')).toBe(false);
    await expect(storage.exists('denied')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('S3 book adapter', () => {
  it('decodes UTF-8 text and maps missing/unavailable S3 responses', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('कहानी')]), ContentLength: 15 })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockRejectedValueOnce(new Error('credentials unavailable'));
    const storage = new S3BookStorage({ send } as unknown as S3Client, 'test-bucket');
    expect(await storage.readText('story')).toBe('कहानी');
    await expect(storage.readText('missing')).rejects.toMatchObject({ statusCode: 404 });
    await expect(storage.readText('failed')).rejects.toMatchObject({ statusCode: 503 });
  });
  it('rejects oversized content before buffering it', async () => {
    const stream = Readable.from(['large']);
    const send = vi.fn().mockResolvedValue({ Body: stream, ContentLength: 9 * 1024 * 1024 });
    await expect(
      new S3BookStorage({ send } as unknown as S3Client, 'test').readText('large'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(stream.destroyed).toBe(true);
  });
});

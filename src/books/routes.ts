import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { BookStorage } from './storage.js';

const key = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('%') &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      !value.split('/').some((part) => part === '..' || part === '.' || !part),
  );
const chapterSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    sourceLanguage: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/),
    audioKey: key.nullish(),
    transcriptKey: key.optional(),
    summaryKey: key.nullish(),
    originalSummaryKey: key.nullish(),
    refinedStoryKey: key.nullish(),
    englishTranslationKey: key.nullish(),
    images: z
      .array(
        z.object({
          key,
          alt: z.string().min(1).max(2000),
          caption: z.string().max(4000).optional(),
        }),
      )
      .max(100)
      .default([]),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(500),
    chapters: z.array(chapterSchema).min(1).max(200),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
const paramsSchema = z.object({
  bookId: z.uuid(),
  chapterId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
});

export function registerBookRoutes(app: FastifyInstance, storage: BookStorage, prefix = 'books') {
  async function load(
    params: unknown,
  ): Promise<{ bookId: string; chapterId?: string | undefined; manifest: Manifest }> {
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) throw new AppError(404, 'BOOK_NOT_FOUND', 'Book or chapter not found.');
    const { bookId, chapterId } = parsed.data;
    const text = await storage.readText(`${prefix}/${bookId}/book.json`);
    let manifest: Manifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(text));
    } catch {
      throw new AppError(502, 'BOOK_MANIFEST_INVALID', 'This book is not ready to read.');
    }
    const ids = new Set(manifest.chapters.map((chapter) => chapter.id));
    const allowed = (value: string) =>
      value.startsWith(`${prefix}/${bookId}/`) ||
      new RegExp(`^recordings/[0-9a-fA-F-]{36}/Books/${bookId}/`).test(value);
    const keys = manifest.chapters.flatMap((chapter) => [
      chapter.audioKey,
      chapter.summaryKey,
      chapter.refinedStoryKey,
      chapter.transcriptKey,
      chapter.originalSummaryKey,
      chapter.englishTranslationKey,
      ...chapter.images.map((image) => image.key),
    ]);
    if (ids.size !== manifest.chapters.length || keys.some((value) => value && !allowed(value))) {
      throw new AppError(
        502,
        'BOOK_MANIFEST_INVALID',
        'This book contains invalid content references.',
      );
    }
    return { bookId, chapterId, manifest };
  }
  async function selected(params: unknown) {
    const book = await load(params);
    const index = book.manifest.chapters.findIndex((chapter) => chapter.id === book.chapterId);
    const chapter = book.manifest.chapters[index];
    if (!chapter) throw new AppError(404, 'CHAPTER_NOT_FOUND', 'Chapter not found.');
    return { ...book, chapter, number: index + 1 };
  }
  async function optionalText(value: string | null | undefined) {
    if (!value) return null;
    try {
      return await storage.readText(value);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.statusCode === 404 || error.code === 'BOOK_CONTENT_INVALID')
      )
        return null;
      throw error;
    }
  }
  async function available(value: string | null | undefined) {
    return value ? storage.exists(value) : false;
  }
  app.get('/api/v1/books/:bookId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { bookId, manifest } = await load(request.params);
    const chapters = [];
    // Bound concurrent S3 reads while preserving manifest order.
    for (let start = 0; start < manifest.chapters.length; start += 4) {
      chapters.push(
        ...(await Promise.all(
          manifest.chapters.slice(start, start + 4).map(async (chapter, offset) => {
            const [summary, originalSummary, hasAudio, hasRefinedStory, hasEnglishTranslation] =
              await Promise.all([
                optionalText(chapter.summaryKey),
                optionalText(chapter.originalSummaryKey),
                available(chapter.audioKey),
                available(chapter.refinedStoryKey),
                chapter.sourceLanguage === 'en'
                  ? Promise.resolve(false)
                  : available(chapter.englishTranslationKey),
              ]);
            return {
              id: chapter.id,
              number: start + offset + 1,
              sourceLanguage: chapter.sourceLanguage,
              summary,
              originalSummary,
              hasAudio,
              hasRefinedStory,
              hasEnglishTranslation,
            };
          }),
        )),
      );
    }
    return { id: bookId, title: manifest.title, chapters };
  });
  app.get('/api/v1/books/:bookId/chapters/:chapterId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z
      .object({ version: z.enum(['original', 'english']).default('original') })
      .strict()
      .safeParse(request.query);
    if (!query.success) throw new AppError(400, 'INVALID_VERSION', 'Choose original or english.');
    const { bookId, manifest, chapter, number } = await selected(request.params);
    const version = query.data.version;
    const textKey =
      version === 'original' || chapter.sourceLanguage === 'en'
        ? chapter.refinedStoryKey
        : chapter.englishTranslationKey;
    if (!textKey)
      throw new AppError(404, 'TRANSLATION_NOT_FOUND', 'An English translation is not available.');
    const text = await storage.readText(textKey);
    const images = await Promise.all(
      chapter.images.map(async (image) => ({
        alt: image.alt,
        ...(image.caption ? { caption: image.caption } : {}),
        ...(await storage.signMedia(image.key)),
      })),
    );
    return {
      bookId,
      bookTitle: manifest.title,
      id: chapter.id,
      number,
      sourceLanguage: chapter.sourceLanguage,
      language: version === 'english' ? 'en' : chapter.sourceLanguage,
      version,
      text,
      images,
      hasRefinedStory: await available(chapter.refinedStoryKey),
      hasEnglishTranslation:
        chapter.sourceLanguage !== 'en' && (await available(chapter.englishTranslationKey)),
    };
  });
  app.get('/api/v1/books/:bookId/chapters/:chapterId/audio', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { chapter } = await selected(request.params);
    if (!chapter.audioKey)
      throw new AppError(404, 'BOOK_CONTENT_NOT_FOUND', 'Original recording is unavailable.');
    return storage.signMedia(chapter.audioKey);
  });
}

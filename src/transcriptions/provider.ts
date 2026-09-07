import { createReadStream } from 'node:fs';

import OpenAI from 'openai';

export interface TranscriptionProviderResult {
  text: string;
  detectedLanguages: string[];
}

export interface TranscriptionProvider {
  transcribe(filePath: string): Promise<TranscriptionProviderResult>;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(filePath: string): Promise<TranscriptionProviderResult> {
    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: this.model,
    });
    const languages =
      'languages' in response && Array.isArray(response.languages)
        ? response.languages.flatMap((language) =>
            typeof language === 'object' &&
            language !== null &&
            'code' in language &&
            typeof language.code === 'string'
              ? [language.code]
              : [],
          )
        : [];
    return { text: response.text, detectedLanguages: languages };
  }
}

export class MissingApiKeyTranscriptionProvider implements TranscriptionProvider {
  async transcribe(): Promise<never> {
    throw new Error('OPENAI_API_KEY is not configured');
  }
}

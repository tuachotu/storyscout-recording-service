import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { AppError } from '../errors.js';

export interface Participant {
  guid: string;
  displayName: string;
}

const PayloadSchema = z.object({
  guid: z.uuid(),
  displayName: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export class AccessSessions {
  private readonly participants: Map<string, Participant>;

  constructor(
    participants: Participant[],
    private readonly secret: string,
    private readonly lifetimeSeconds: number,
  ) {
    this.participants = new Map(participants.map((participant) => [participant.guid, participant]));
  }

  issue(guid: string): { accessToken: string; displayName: string; expiresAt: string } {
    const participant = this.participants.get(guid);
    if (!participant) throw new AppError(401, 'ACCESS_DENIED', 'The access code is not valid.');
    const expiresAt = Math.floor(Date.now() / 1000) + this.lifetimeSeconds;
    const payload = Buffer.from(JSON.stringify({ ...participant, expiresAt })).toString(
      'base64url',
    );
    return {
      accessToken: `${payload}.${this.sign(payload)}`,
      displayName: participant.displayName,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  verify(token: string | undefined): Participant {
    if (!token) throw unauthorized();
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !safeEqual(signature, this.sign(payload)))
      throw unauthorized();
    let parsed: z.infer<typeof PayloadSchema>;
    try {
      parsed = PayloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw unauthorized();
    }
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new AppError(401, 'ACCESS_EXPIRED', 'The access session has expired.');
    }
    const participant = this.participants.get(parsed.guid);
    if (!participant || participant.displayName !== parsed.displayName) throw unauthorized();
    return participant;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function unauthorized(): AppError {
  return new AppError(401, 'ACCESS_REQUIRED', 'A valid access session is required.');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

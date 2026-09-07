import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      requestId: request.id,
    },
  };

  return reply.status(statusCode).send(body);
}

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

interface ErrorBody {
  code?: number;
  message?: string | string[];
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException
      ? exception.getResponse()
      : null;
    const body = typeof response === 'object' && response !== null
      ? response as ErrorBody
      : {};
    const rawMessage = body.message
      ?? (typeof response === 'string' ? response : undefined)
      ?? (exception instanceof Error ? exception.message : 'internal_error');
    const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : rawMessage;
    const requestIdHeader = request.headers['x-request-id'];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader ?? randomUUID();

    if (status >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    reply.status(status).send({
      code: body.code ?? status * 100 + 1,
      message: status >= 500 && process.env.NODE_ENV === 'production'
        ? 'internal_error'
        : message,
      request_id: requestId,
      data: null,
    });
  }
}

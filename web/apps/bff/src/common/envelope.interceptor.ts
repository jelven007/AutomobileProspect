import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, map } from 'rxjs';

interface Envelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

/** 统一响应包装：{ code, message, request_id, data }。若 handler 已自行 send（如二进制下载），则透传。 */
@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T> | T> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const reply = http.getResponse<{ sent?: boolean; raw?: { headersSent?: boolean } }>();
    const rawRid = req.headers?.['x-request-id'];
    const rid = (Array.isArray(rawRid) ? rawRid[0] : rawRid) ?? randomUUID();
    return next.handle().pipe(
      map((data) => {
        if (reply?.sent || reply?.raw?.headersSent) return data as T;
        return { code: 0, message: 'ok', request_id: String(rid), data } as Envelope<T>;
      }),
    );
  }
}

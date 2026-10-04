import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { EnvelopeInterceptor } from './common/envelope.interceptor';

async function bootstrap() {
  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 512);
  const maxUploadBytes = maxUploadMb * 1024 * 1024;
  const adapter = new FastifyAdapter({
    logger: true,
    bodyLimit: maxUploadBytes,
    keepAliveTimeout: 15 * 60 * 1000,
    connectionTimeout: 15 * 60 * 1000,
    disableRequestLogging: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(multipart as never, {
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fieldSize: 1024 * 1024,
      headerPairs: 2000,
    },
  });
  app.setGlobalPrefix('bff');
  const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = new Set(
    configuredOrigins.length > 0
      ? configuredOrigins
      : process.env.NODE_ENV === 'production'
        ? []
        : ['http://localhost:5175', 'http://127.0.0.1:5175'],
  );
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('cors_origin_not_allowed'), false);
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'X-Export-Groups', 'X-Export-Total'],
  });
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  const port = Number(process.env.PORT ?? 7001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[bff] listening on http://localhost:${port}/bff`);
}

bootstrap();

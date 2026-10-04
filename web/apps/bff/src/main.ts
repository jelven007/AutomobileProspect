import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { EnvelopeInterceptor } from './common/envelope.interceptor';

async function bootstrap() {
  // 支撑 200MB xlsx 导入：
  //  - bodyLimit 放到 512MB（Fastify 默认 1MB 会拒 200MB payload）
  //  - keepAliveTimeout 调到 15 分钟（200MB 清洗预计 5–10 分钟）
  //  - disableRequestLogging 关掉大文件 req 日志，避免 pino 高频写盘拖慢
  const adapter = new FastifyAdapter({
    logger: true,
    bodyLimit: 512 * 1024 * 1024,
    keepAliveTimeout: 15 * 60 * 1000,
    connectionTimeout: 15 * 60 * 1000,
    disableRequestLogging: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(multipart as never, {
    limits: {
      fileSize: 512 * 1024 * 1024,  // 单文件上限 512MB，覆盖 200MB 场景并留出余量
      files: 1,
      fieldSize: 1024 * 1024,
      headerPairs: 2000,
    },
  });
  app.setGlobalPrefix('bff');
  app.enableCors({
    origin: true,
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

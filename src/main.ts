import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import * as express from 'express';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // ← обязательно для Better Auth
  });
  app.enableCors({
    origin: 'https://your-app.vercel.app', // Ваш домен на Vercel
    credentials: true, // Разрешить отправку куки
  });
  app.enableShutdownHooks();

  // DEBUG: логируем входящие вебхуки ДО парсера
  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    console.log('[DEBUG] Webhook request:', {
      method: req.method,
      path: req.path,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
    });
    next();
  });

  // Сырой body ТОЛЬКО для /webhooks/* — ручное чтение (надежнее express.raw)
  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      (req as any).rawBody = rawBody;
      console.log('[DEBUG] Manual raw parser: read', rawBody.length, 'bytes');
      next();
    });
    req.on('error', (err) => {
      console.error('[DEBUG] Raw body read error:', err);
      next(err);
    });
  });

  // DEBUG: проверяем, что rawBody появился
  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    const rawReq = req as any;
    console.log('[DEBUG] After manual parser:', {
      hasRawBody: !!rawReq.rawBody,
      rawBodyLength: rawReq.rawBody?.length,
      rawBodyPreview: rawReq.rawBody?.toString?.().slice(0, 200),
    });
    next();
  });

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

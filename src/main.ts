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

  // Сырой body ТОЛЬКО для /webhooks/* — ДО любых других парсеров
  // type: функция, матчит любой application/json (с charset и без)
  app.use(
    '/webhooks',
    express.raw({
      type: (req) => req.headers['content-type']?.startsWith('application/json') ?? false,
    }),
  );

  // DEBUG: проверяем, что rawBody появился (используем any для доступа к rawBody)
  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    const rawReq = req as any;
    console.log('[DEBUG] After raw parser:', {
      hasRawBody: !!rawReq.rawBody,
      rawBodyLength: rawReq.rawBody?.length,
      rawBodyPreview: rawReq.rawBody?.toString?.().slice(0, 200),
    });
    next();
  });

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

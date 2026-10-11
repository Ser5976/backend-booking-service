import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // ← обязательно для Better Auth
  });
  app.enableCors({
    origin: 'https://your-app.vercel.app', // Ваш домен на Vercel
    credentials: true, // Разрешить отправку куки
  });
  app.enableShutdownHooks();
  // Сырой body ТОЛЬКО для /webhooks/* — ДО любых других парсеров
  // type: функция, матчит любой application/json (с charset и без)
  app.use(
    '/webhooks',
    express.raw({
      type: (req) => req.headers['content-type']?.startsWith('application/json') ?? false,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

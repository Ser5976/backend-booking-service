import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import * as express from 'express';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // ← обязательно для Better Auth
  });
  app.enableCors({
    origin: 'https://your-app.vercel.app', // Ваш домен на Vercel
    credentials: true, // Разрешить отправку куки
  });
  app.enableShutdownHooks();
  // Сырой body только для /webhooks/*
  app.use('/webhooks', express.raw({ type: 'application/json' }));
  await app.listen(process.env.PORT ?? 3000);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
await bootstrap();

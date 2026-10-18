import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Request, Response, NextFunction } from 'express';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });
  app.enableCors({
    origin: 'https://your-app.vercel.app',
    credentials: true,
  });
  app.enableShutdownHooks();

  // Raw body для webhooks — ручное чтение (надежнее express.raw на Render)
  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      (req as any).rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', next);
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

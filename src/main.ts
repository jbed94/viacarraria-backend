import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module.js';
import { auth } from './auth.js';
import { UpstashRateLimitService } from './common/services/upstash-rate-limit.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api');
  const allowedOrigins = (
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173'
  ).split(',');
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
  });
  const rateLimit = app.get(UpstashRateLimitService);
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.use(
    '/api/auth',
    async (
      request: Request,
      response: Response,
      next: NextFunction,
    ): Promise<void> => {
      const ip = request.ip || request.socket.remoteAddress || 'unknown';
      const kind = request.path.endsWith('/sign-in/anonymous')
        ? 'guest'
        : 'request';
      const result = await rateLimit.limit(
        kind,
        `ip:${ip}`,
        ip,
        request.get('user-agent'),
      );
      response.setHeader('X-RateLimit-Limit', result.limit);
      response.setHeader('X-RateLimit-Remaining', result.remaining);
      response.setHeader('X-RateLimit-Reset', result.reset);
      if (!result.success) {
        response.status(429).json({
          message: 'Too many requests. Please try again shortly.',
        });
        return;
      }
      next();
    },
  );
  expressApp.all('/api/auth/{*any}', toNodeHandler(auth));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();

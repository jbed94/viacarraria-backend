import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import { auth } from './auth.js';
import { UpstashRateLimitService } from './common/services/upstash-rate-limit.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const defaultOrigins = [
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4174',
    'http://127.0.0.1:4174',
  ];
  const allowedOrigins = Array.from(
    new Set([...configuredOrigins, ...defaultOrigins]),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', '*'],
          connectSrc: ["'self'", '*'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'self'", 'blob:', ...allowedOrigins],
          frameAncestors: ["'self'", ...allowedOrigins],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      frameguard: false,
    }),
  );
  app.setGlobalPrefix('api');
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
  expressApp.use(
    '/api/sources/direct-upload',
    express.raw({ type: '*/*', limit: '50mb' }),
  );
  app.use(
    express.json({
      limit: '5mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
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

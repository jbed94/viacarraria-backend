import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { AuthService } from '../../modules/auth/auth.service.js';
import type { AuthenticatedRequest } from '../types.js';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(
    request: AuthenticatedRequest,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    request.identity = await this.authService.resolveIdentity(request);
    next();
  }
}

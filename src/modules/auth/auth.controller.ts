import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import { ChangePasswordDto, UpdateProfileDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('profile')
  async profile(@Req() request: AuthenticatedRequest) {
    return this.authService.profile(
      this.authService.requireIdentity(request.identity),
    );
  }

  @Get('limits')
  async limits(@Req() request: AuthenticatedRequest) {
    return this.authService.limits(request.identity);
  }

  @Patch('profile')
  async updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(
      this.authService.requireIdentity(request.identity),
      dto,
    );
  }

  @HttpCode(204)
  @Post('profile/change-password')
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.authService.changePassword(
      this.authService.requireIdentity(request.identity),
      request,
      dto,
    );
  }

  @Get('sessions')
  async sessions(@Req() request: AuthenticatedRequest) {
    return this.authService.sessions(
      this.authService.requireIdentity(request.identity),
    );
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.authService.revokeSession(
      this.authService.requireIdentity(request.identity),
      request,
      id,
    );
  }

  @HttpCode(204)
  @Delete('profile')
  async deleteProfile(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.authService.deleteProfile(
      this.authService.requireIdentity(request.identity),
      request,
    );
  }
}

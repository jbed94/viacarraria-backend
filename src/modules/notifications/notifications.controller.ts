import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/types.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return this.notificationsService.list(request.identity);
  }

  @Patch('read-all')
  async markAllAsRead(@Req() request: AuthenticatedRequest) {
    return this.notificationsService.markAllAsRead(request.identity);
  }

  @Patch(':id/read')
  async markAsRead(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markAsRead(request.identity, id);
  }

  @HttpCode(204)
  @Delete(':id')
  async delete(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.notificationsService.delete(request.identity, id);
  }
}

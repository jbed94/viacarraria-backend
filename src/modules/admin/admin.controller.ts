import { Controller, Get } from '@nestjs/common';

import { AdminService } from './admin.service.js';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  async health() {
    return this.adminService.health();
  }
}

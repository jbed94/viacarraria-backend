import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageService } from '../../common/services/storage.service.js';
import type { AuthenticatedRequest } from '../../common/types.js';
import { GraphRetentionService } from '../graphs/graph-retention.service.js';
import { AdminService } from './admin.service.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly retentionService: GraphRetentionService,
    private readonly storage: StorageService,
  ) {}

  // 1. Health & System Monitoring
  @Get('health')
  async health() {
    return this.adminService.health();
  }

  @Get('status')
  async status() {
    const settings = await this.adminService.getSystemSettings();
    return {
      status: 'ok',
      maintenanceMode: settings.maintenanceMode,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('system/status')
  async getSystemStatus() {
    return this.adminService.getSystemStatus();
  }

  @Get('storage/proxy-status')
  async getStorageProxyStatus() {
    return this.storage.getStorageProxyStatus();
  }

  // 2. Overview Analytics & Business KPI
  @Get('overview')
  async getOverviewStats() {
    return this.adminService.getOverviewStats();
  }

  // 3. User Management
  @Get('users')
  async getUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('tier') tier?: string,
  ) {
    return this.adminService.getUsers({
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      search,
      tier,
    });
  }

  @Get('users/export')
  async exportUsers(
    @Res() res: Response,
    @Query('format') format?: 'csv' | 'json',
    @Query('search') search?: string,
    @Query('tier') tier?: string,
  ) {
    const exportFormat = format === 'json' ? 'json' : 'csv';
    const result = await this.adminService.exportUsers({
      format: exportFormat,
      search,
      tier,
    });
    const date = new Date().toISOString().split('T')[0];
    if (exportFormat === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="users-audit-${date}.csv"`,
      );
      return res.send(result);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="users-audit-${date}.json"`,
    );
    return res.json(result);
  }

  @Post('users/batch')
  async batchUsers(
    @Body()
    body: {
      userIds: string[];
      action: 'set_tier' | 'delete';
      tier?: string;
      durationDays?: number;
    },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.batchUsers(body, req.identity)
      : this.adminService.batchUsers(body);
  }

  @Get('users/:id')
  async getUserDetails(@Param('id') id: string) {
    return this.adminService.getUserDetails(id);
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      username?: string;
      subscriptionTier?: string;
      subscriptionExpiresAt?: string | null;
    },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.updateUser(id, body, req.identity)
      : this.adminService.updateUser(id, body);
  }

  @Delete('users/:id')
  async deleteUser(@Param('id') id: string, @Req() req?: AuthenticatedRequest) {
    return req?.identity
      ? this.adminService.deleteUser(id, req.identity)
      : this.adminService.deleteUser(id);
  }

  // 4. Graphs Management & Content Modification
  @Get('graphs')
  async getGraphs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('visibility') visibility?: string,
    @Query('retention') retention?: string,
  ) {
    return this.adminService.getGraphs({
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      search,
      visibility,
      retention,
    });
  }

  @Post('graphs/batch')
  async batchGraphs(
    @Body()
    body: {
      graphIds: string[];
      action: 'set_retention_exempt' | 'set_visibility' | 'delete';
      exempt?: boolean;
      isPublic?: boolean;
    },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.batchGraphs(body, req.identity)
      : this.adminService.batchGraphs(body);
  }

  @Get('graphs/:id')
  async getGraphDetails(@Param('id') id: string) {
    return this.adminService.getGraphDetails(id);
  }

  @Patch('graphs/:id')
  async updateGraph(
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      description?: string | null;
      isPublic?: boolean;
      isExemptFromRetention?: boolean;
      resetRetention?: boolean;
    },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.updateGraph(id, body, req.identity)
      : this.adminService.updateGraph(id, body);
  }

  @Put('graphs/:id/content')
  async updateGraphContent(
    @Param('id') id: string,
    @Body() body: { nodes: any[]; edges: any[] },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.updateGraphContent(id, body, req.identity)
      : this.adminService.updateGraphContent(id, body);
  }

  @Delete('graphs/:id')
  async deleteGraph(
    @Param('id') id: string,
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.deleteGraph(id, req.identity)
      : this.adminService.deleteGraph(id);
  }

  // 5. Retention & Cold Storage
  @Post('retention/run')
  async runRetention(
    @Query('dryRun') queryDryRun?: string,
    @Body('dryRun') bodyDryRun?: boolean,
    @Req() req?: AuthenticatedRequest,
  ) {
    const dryRun = queryDryRun === 'true' || bodyDryRun === true;
    const result = await this.retentionService.runRetentionSweep({ dryRun });
    if (typeof this.adminService.recordAuditEvent === 'function') {
      await this.adminService.recordAuditEvent({
        actorId: req?.identity?.userId ?? 'admin',
        actorEmail: req?.identity?.email ?? undefined,
        action: dryRun ? 'retention.dry_run' : 'retention.sweep',
        targetType: 'retention',
        details: {
          scheduledCount: result.scheduled.count,
          purgedCount: result.purged.count,
        },
      });
    }
    return result;
  }

  @Get('retention/audit')
  async getRetentionAudit() {
    return this.retentionService.getAuditStats();
  }

  @Get('retention/archives')
  async getRetentionArchives() {
    return this.retentionService.getArchives();
  }

  @Get('graphs/:id/archive')
  async downloadGraphArchive(
    @Param('id') graphId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const archive = await this.retentionService.getArchiveByGraphId(graphId);
    if (!archive) {
      throw new NotFoundException(
        `No cold storage archive found for graph ${graphId}`,
      );
    }

    const file = await this.storage.getObject(archive.archiveUrl);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${archive.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_archive.tar.gz"`,
      'Content-Length': file.contentLength.toString(),
    });

    return new StreamableFile(file.buffer);
  }

  @Post('graphs/:id/restore')
  async restoreGraphArchive(@Param('id') graphId: string) {
    return this.retentionService.restoreGraphFromArchive(
      graphId,
      undefined,
      true,
    );
  }

  @Delete('retention/archives/:graphId')
  async deleteArchive(@Param('graphId') graphId: string) {
    return this.adminService.deleteArchive(graphId);
  }

  // 6. Subscriptions & Billing
  @Get('subscriptions/events')
  async getSubscriptionEvents(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getSubscriptionEvents({
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get('subscriptions/events/export')
  async exportSubscriptionEvents(
    @Res() res: Response,
    @Query('format') format?: 'csv' | 'json',
  ) {
    const exportFormat = format === 'json' ? 'json' : 'csv';
    const result = await this.adminService.exportSubscriptionEvents({
      format: exportFormat,
    });
    const date = new Date().toISOString().split('T')[0];
    if (exportFormat === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="billing-events-${date}.csv"`,
      );
      return res.send(result);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="billing-events-${date}.json"`,
    );
    return res.json(result);
  }

  @Post('subscriptions/grant')
  async grantSubscription(
    @Body()
    body: {
      userId: string;
      tier?: 'PRO';
      durationDays?: number;
    },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.grantSubscription(
          body.userId,
          body.tier,
          body.durationDays,
          req.identity,
        )
      : this.adminService.grantSubscription(
          body.userId,
          body.tier,
          body.durationDays,
        );
  }

  @Post('subscriptions/revoke')
  async revokeSubscription(
    @Body() body: { userId: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    return req?.identity
      ? this.adminService.revokeSubscription(body.userId, req.identity)
      : this.adminService.revokeSubscription(body.userId);
  }

  // 7. Admin Session Verification
  @Get('auth/verify')
  async verifyAdminAccess(@Req() req: AuthenticatedRequest) {
    return {
      authorized: true,
      identity: req.identity,
      timestamp: new Date().toISOString(),
    };
  }

  // 8. System Configuration & Limits
  @Get('settings')
  async getSettings() {
    return this.adminService.getSystemSettings();
  }

  @Patch('settings')
  async updateSettings(@Body() patch: any, @Req() req?: AuthenticatedRequest) {
    return this.adminService.updateSystemSettings(patch, req?.identity);
  }

  // 9. Real-Time Admin Audit Log Stream
  @Get('audit-logs')
  async getAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : 50;
    const p = page ? Number.parseInt(page, 10) : 1;
    const offset = (p - 1) * lim;
    return this.adminService.getAuditLogs({
      limit: lim,
      offset,
      action,
      targetType,
    });
  }

  @Post('audit-logs/archive')
  async archiveAuditLogs(
    @Body() dto?: { olderThanDays?: number; retainCount?: number },
    @Req() req?: AuthenticatedRequest,
  ) {
    return this.adminService.archiveAuditLogs(dto, req?.identity);
  }

  @Get('audit-logs/archives')
  async getAuditArchives(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : 50;
    const p = page ? Number.parseInt(page, 10) : 1;
    const offset = (p - 1) * lim;
    return this.adminService.getAuditArchives({
      limit: lim,
      offset,
    });
  }

  @Get('audit-logs/archives/:id/download')
  async downloadAuditArchive(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.adminService.downloadAuditArchive(id);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.contentLength.toString(),
    });
    return new StreamableFile(file.buffer);
  }

  @Get('audit-logs/archives/:id/preview')
  async previewAuditArchive(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : 50;
    const p = page ? Number.parseInt(page, 10) : 1;
    const offset = (p - 1) * lim;
    return this.adminService.getAuditArchiveContent(id, {
      search,
      limit: lim,
      offset,
    });
  }
}

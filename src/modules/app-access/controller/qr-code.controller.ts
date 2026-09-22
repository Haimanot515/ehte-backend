import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { QrCodeService } from '../service/qr-code.service';

@ApiTags('App Access')
@Controller('admin/app-access/qr-code')
export class QrCodeController {
  constructor(
    private readonly qrCodeService: QrCodeService,
    private readonly config: ConfigService,
  ) {}

  // ADMIN — GET QR CODE: generated on demand from APP_URL, never stored.
  // Encodes the public /app smart-redirect endpoint (device detection ->
  // Google Play / App Store / fallback page). Not the redirect itself —
  // scanning the resulting image is what hits /app.

  @RequirePermissions(PermissionsEnum.APP_ACCESS_QR_READ)
  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Generate the Ehte mobile app's access QR code (PNG or SVG), built from APP_URL",
  })
  async getQrCode(
    @Query('format') format: 'png' | 'svg' = 'png',
    @Res() res: Response,
  ): Promise<void> {
    const publicUrl = this.config.getOrThrow<string>('APP_URL');
    const redirectUrl = `${publicUrl.replace(/\/$/, '')}/app`;

    if (format === 'svg') {
      const svg = await this.qrCodeService.generateSvg(redirectUrl);
      res.type('image/svg+xml').send(svg);
      return;
    }

    const png = await this.qrCodeService.generatePng(redirectUrl);
    res.type('image/png').send(png);
  }
}
import {
  Body,
  Controller,
  Delete,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Express } from 'express';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { MediaFolder } from 'src/common/enums/media-folder.enum';

import { MediaService } from '../service/media.service';
import { PresignedUploadDto } from '../dto/presigned-upload.dto';
import { MediaKeyQueryDto } from '../dto/media-key-query.dto';
import { UploadMediaDto } from '../dto/upload-media.dto';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditSeverity } from '@prisma/client';

const MAX_UPLOAD_BYTES = 52_428_800;

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('presigned-upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned upload URL for a direct-to-storage upload',
  })
  @AuditEvent({ action: AuditEventEnum.MEDIA_PRESIGNED_UPLOAD_CREATED, entity: 'Media' })
  async createPresignedUpload(@Body() data: PresignedUploadDto) {
    return this.mediaService.createPresignedUpload(data);
  }

  @Post('upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Upload a file through the API (use this to test uploads from Swagger)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'folder'],
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: { type: 'string', enum: Object.values(MediaFolder) },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @AuditEvent({ action: AuditEventEnum.MEDIA_UPLOADED, entity: 'Media', entityId: { response: ['key', 'id', 'filepath', 'path'] } })
  async uploadFile(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadMediaDto,
  ) {
    return this.mediaService.uploadFile(file, body.folder);
  }

  // Object keys contain slashes, so key is a query param and not a route param.
  @Delete()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MEDIA_DELETE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: delete an object from the media bucket',
  })
  @AuditEvent({ action: AuditEventEnum.MEDIA_DELETED, entity: 'Media', entityId: { query: 'key' }, severity: AuditSeverity.WARNING })
  async deleteObject(@Query() query: MediaKeyQueryDto) {
    return this.mediaService.deleteObject(query.key);
  }
}
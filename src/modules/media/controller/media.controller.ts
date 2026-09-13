import { Body, Controller, Delete, Post, Query } from '@nestjs/common';

import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import { MediaService } from '../service/media.service';
import { PresignedUploadDto } from '../dto/presigned-upload.dto';
import { MediaKeyQueryDto } from '../dto/media-key-query.dto';

// ─────────────────────────────────────────────
// Generic media module: presigned-upload + delete only.
//
// Deliberately does NOT expose a generic download endpoint — see
// MediaService's header comment and VictimProfileService's
// getMediaDownloadUrl / getPublicMediaDownloadUrl for why download
// authorization must live next to the domain's own visibility
// rules (child-profile photo suppression, publish-state gating,
// etc.) rather than here.
//
// ASSUMPTION: PermissionsEnum.MEDIA_UPLOAD / MEDIA_DELETE are new
// members that need to be added to PermissionsEnum, and wired into
// whichever role→permission map already grants ADMIN/SUPER_ADMIN
// their other permissions (the same file that currently withholds
// SUPPORT_PAYMENT_MANAGE from plain ADMIN). Swap these for existing
// enum values if you'd rather reuse something already defined.
// ─────────────────────────────────────────────

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // ─────────────────────────────────────────────
  // POST /media/presigned-upload
  // ─────────────────────────────────────────────

  @Post('presigned-upload')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MEDIA_UPLOAD)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: get a presigned upload URL for a direct-to-storage upload',
  })
  async createPresignedUpload(
    @Body()
    data: PresignedUploadDto,
  ) {
    return this.mediaService.createPresignedUpload(data);
  }

  // ─────────────────────────────────────────────
  // DELETE /media?key=...
  //
  // key is a query param, not a route param — object keys contain
  // slashes (e.g. victim-profiles/photos/<uuid>.jpg) and a plain
  // Express/Nest route segment does not span multiple `/`-delimited
  // segments, so `:key` would silently truncate at the first slash.
  // ─────────────────────────────────────────────

  @Delete()
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.MEDIA_DELETE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Admin: delete an object from the media bucket',
  })
  async deleteObject(
    @Query()
    query: MediaKeyQueryDto,
  ) {
    return this.mediaService.deleteObject(query.key);
  }
}
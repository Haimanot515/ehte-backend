import { Injectable } from '@nestjs/common';

import { MinioService } from 'src/services/minio/minio.service';

import { PresignedUploadDto } from '../dto/presigned-upload.dto';

// ─────────────────────────────────────────────
// Deliberately domain-agnostic. This service knows nothing about
// VictimProfile, Post, Report, or any other media-bearing entity —
// it only issues presigned upload URLs and deletes objects by key.
//
// That's safe for upload/delete because neither operation leaks
// existing content: a presigned PUT lets you write a new object at
// a key you were just handed, and delete requires you already know
// the exact key. Neither reveals what's in the bucket.
//
// Reading/downloading is NOT handled here on purpose — see
// VictimProfileService.getMediaDownloadUrl /
// getPublicMediaDownloadUrl instead. Serving a presigned GET URL
// for an arbitrary key with no ownership check would let any caller
// with a key string bypass a profile's own visibility rules (e.g.
// child-profile photo suppression in serializePublicProfile). Keep
// download authorization living next to the domain rules it has to
// respect, not in this generic module.
// ─────────────────────────────────────────────

@Injectable()
export class MediaService {
  constructor(private readonly minioService: MinioService) {}

  async createPresignedUpload(
    dto: PresignedUploadDto,
  ): Promise<{ presignedUrl: string; key: string }> {
    const { presignedUrl, file } = await this.minioService.generatePresignedUploadUrl({
      originalname: dto.originalname,
      contentType: dto.contentType,
      folder: dto.folder,
    });

    // file.filepath is set unconditionally by
    // generatePresignedUploadUrl — safe to assert non-null here.
    return { presignedUrl, key: file.filepath as string };
  }

  async deleteObject(key: string): Promise<{ message: string; key: string }> {
    await this.minioService.deleteFile(key);
    return { message: 'media_deleted', key };
  }
}
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Express } from 'express';

import { MinioService } from 'src/services/minio/minio.service';

import { PresignedUploadDto } from '../dto/presigned-upload.dto';
import { MediaFolder } from '../../../common/enums/media-folder.enum';

// Domain-agnostic on purpose: downloads stay in each domain service so visibility rules are enforced there.

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

    return { presignedUrl, key: file.filepath as string };
  }

  async uploadFile(
    file: Express.Multer.File | undefined,
    folder: MediaFolder,
  ): Promise<{ key: string; contentType: string; size: number }> {
    if (!file) {
      throw new BadRequestException('file_required');
    }

    const key = await this.minioService.uploadMulterFile(file, folder);

    return { key, contentType: file.mimetype, size: file.size };
  }

  async deleteObject(key: string): Promise<{ message: string; key: string }> {
    await this.minioService.deleteFile(key);
    return { message: 'media_deleted', key };
  }
}
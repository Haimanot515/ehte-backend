import { Injectable, NotFoundException } from '@nestjs/common';
import { InformationStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { ListInformationSubmissionsQueryDto } from '../dto/information-submission.dto';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  async getPublicMediaDownloadUrl(id: string, key: string): Promise<{ url: string }> {
    const submission = await this.prisma.informationSubmission.findFirst({
      where: {
        id,
        status: InformationStatus.REVIEWED,
        deletedAt: null, // NEW (soft delete)
      },
      select: {
        photo: true,
        video: true,
        audio: true,
        pdf: true,
        document: true,
        other: true,
      },
    });

    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const owned = this.informationSubmissionCommonService
      .collectMediaFields(submission)
      .includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_submission');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findForMissingPerson(missingPersonId: string, query: ListInformationSubmissionsQueryDto) {
    return this.cache.wrapInformationSubmissionList(
      missingPersonId,
      query as unknown as Record<string, unknown>,
      () => this.findForMissingPersonUncached(missingPersonId, query),
    );
  }

  private async findForMissingPersonUncached(
    missingPersonId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
    const missingPerson = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
    });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      missingPersonId,
      status: { in: [InformationStatus.REVIEWED] },
      deletedAt: null, // NEW (soft delete)
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        select: {
          id: true,
          information: true,
          location: true,
          photo: true,
          video: true,
          audio: true,
          pdf: true,
          document: true,
          other: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}

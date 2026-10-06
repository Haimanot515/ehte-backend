import { Injectable, NotFoundException } from '@nestjs/common';
import { PostStatus, PostType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { PublishedPostsQueryDto } from '../dto/post.dto';
import { PostCommonService } from './post-common.service';
import { MediaFieldName, MediaBearing, PUBLIC_POST_OMIT_FIELDS } from './post.constants';

type PublicPost = ReturnType<PostPublicService['toPublicPost']>;

@Injectable()
export class PostPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly postCommonService: PostCommonService,
  ) {}

  private getPubliclyVisibleMediaKeys(
    post: Pick<MediaBearing, MediaFieldName> & { involvesChild: boolean },
  ): string[] {
    return post.involvesChild ? [] : this.postCommonService.collectMediaFields(post);
  }

  // Strips fields a public reader has no business seeing, most importantly userId.
  private toPublicPost<T extends Record<string, unknown>>(
    post: T,
  ): Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]> {
    const copy: Record<string, unknown> = { ...post };
    for (const field of PUBLIC_POST_OMIT_FIELDS) {
      delete copy[field];
    }
    return copy as Omit<T, (typeof PUBLIC_POST_OMIT_FIELDS)[number]>;
  }

  async getMediaDownloadUrl(postId: string, key: string): Promise<{ url: string }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const owned = this.postCommonService.collectMediaFields(post).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_post');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async getPublicMediaDownloadUrl(postId: string, key: string): Promise<{ url: string }> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },

      select: {
        photo: true,
        video: true,
        audio: true,
        pdf: true,
        document: true,
        other: true,
        involvesChild: true,
      },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const allowedKeys = this.getPubliclyVisibleMediaKeys(post);
    if (!allowedKeys.includes(key)) {
      throw new NotFoundException('media_not_found_on_post');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findPublishedPosts(query: PublishedPostsQueryDto) {
    return this.cache.wrapPostList(query as unknown as Record<string, unknown>, () =>
      this.findPublishedPostsUncached(query),
    );
  }

  private async findPublishedPostsUncached(query: PublishedPostsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const postType: PostType | undefined = query.type;

    const where: Prisma.PostWhereInput = {
      status: PostStatus.PUBLISHED,
      ...(postType ? { type: postType } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toPublicPost(item)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findPublishedPost(postId: string) {
    const cached = await this.cache.getPost<PublicPost>(postId);
    if (cached !== null) return cached;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, status: PostStatus.PUBLISHED },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    const publicPost = this.toPublicPost(post);
    await this.cache.setPost(postId, publicPost);
    return publicPost;
  }
}

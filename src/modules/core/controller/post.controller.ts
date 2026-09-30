import { MediaUpload } from 'src/common/decorators/media-upload.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PostType } from '@prisma/client';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { MediaKeyQueryDto } from 'src/modules/media/dto/media-key-query.dto';
import {
  CreatePostDto,
  UpdatePostDto,
  RequestPostChangesDto,
  ApprovePostDto,
  RejectPostDto,
  AdminCreatePostDto,
  AdminPostQueryDto,
  PublishedPostsQueryDto,
  UpdatePostStatusDto,
  BulkPostIdsDto,
  BulkRejectPostDto,
} from '../dto/post.dto';
import { PostService } from '../service/post.service';

@ApiTags('Posts')
@Controller('posts')
export class PostController {
  constructor(private readonly postService: PostService) {}

  // POST /posts — authenticated user, requires re-auth.
  @Post()
  @MediaUpload(CreatePostDto)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a new post',
  })
  async create(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: CreatePostDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.postService.create(user.id, data, idempotencyKey);
  }

  // GET /posts/me — authenticated user.
  @Get('me')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get posts created by current user',
  })
  async findMyPosts(@CurrentUser() user: CurrentUserDto) {
    return this.postService.findMyPosts(user.id);
  }

  // GET /posts/me/:id — authenticated user.
  @Get('me/:id')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one post created by current user',
  })
  async findMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.findMyPost(user.id, postId);
  }

  // PATCH /posts/me/:id — allowed only while DRAFT or CHANGES_REQUESTED.
  @Patch('me/:id')
  @MediaUpload(UpdatePostDto)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Edit own post before/after review',
  })
  async updateMyPost(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: UpdatePostDto,
  ) {
    return this.postService.updateMyPost(user.id, postId, data);
  }

  // PATCH /posts/me/:id/submit — moves DRAFT/CHANGES_REQUESTED -> PENDING.
  @Patch('me/:id/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submit own post for admin review',
  })
  async submitMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.submitMyPost(user.id, postId);
  }

  // PATCH /posts/me/:id/cancel — PENDING -> DRAFT.
  @Patch('me/:id/cancel')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Withdraw own pending post back to draft',
  })
  async cancelMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.cancelMyPost(user.id, postId);
  }

  // DELETE /posts/me/:id — scoped to DRAFT only.
  @Delete('me/:id')
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Delete own draft post',
  })
  async deleteMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.deleteMyPost(user.id, postId);
  }

  // GET /posts/published — anonymous.
  @Get('published')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get published public posts',
  })
  @ApiQuery({ name: 'type', required: false, enum: PostType })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findPublishedPosts(@Query() query: PublishedPostsQueryDto) {
    return this.postService.findPublishedPosts(query);
  }

  // GET /posts/published/:id/media?key=... — declared before published/:id.
  @Get('published/:id/media')
  @AllowAnonymous()
  @ApiOperation({
    summary: "Get a short-lived download URL for a published post's media",
  })
  async getPublicMedia(@Param('id') postId: string, @Query() query: MediaKeyQueryDto) {
    return this.postService.getPublicMediaDownloadUrl(postId, query.key);
  }

  // GET /posts/published/:id — anonymous.
  @Get('published/:id')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get one published public post',
  })
  async findPublishedPost(@Param('id') postId: string) {
    return this.postService.findPublishedPost(postId);
  }

  // POST /posts/official — admin-authored, distinct from POST /posts.
  @Post('official')
  @MediaUpload(AdminCreatePostDto)
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_CREATE_OFFICIAL)
  @ApiOperation({
    summary: 'Admin: create an official post',
  })
  async createOfficial(@CurrentUser() user: CurrentUserDto, @Body() data: AdminCreatePostDto) {
    return this.postService.createOfficial(user, data);
  }

  // GET /posts — admin, filters/pagination via AdminPostQueryDto.
  @Get()
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get all posts',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'type', required: false, enum: PostType })
  @ApiQuery({ name: 'involvesChild', required: false })
  @ApiQuery({ name: 'authorId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(@Query() query: AdminPostQueryDto) {
    return this.postService.findAll(query);
  }

  // GET /posts/stats — declared before ':id' so "stats" isn't matched as an id.
  @Get('stats')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({
    summary: 'Admin: get post counts by status and type',
  })
  async getStats() {
    return this.postService.getStats();
  }

  // GET /posts/stale — declared before ':id' for the same reason as 'stats'.
  @Get('stale')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get pending posts that have been waiting too long',
  })
  async findStalePending() {
    return this.postService.findStalePending();
  }

  // PATCH /posts/bulk/approve — declared before ':id/approve'.
  @Patch('bulk/approve')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_APPROVE)
  @ApiOperation({
    summary: 'Admin: approve several low-risk posts at once',
  })
  async bulkApprove(@CurrentUser() user: CurrentUserDto, @Body() data: BulkPostIdsDto) {
    return this.postService.bulkApprove(user, data.ids);
  }

  // PATCH /posts/bulk/reject — declared before ':id/reject'.
  @Patch('bulk/reject')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REJECT)
  @ApiOperation({
    summary: 'Admin: reject several low-risk posts at once',
  })
  async bulkReject(@CurrentUser() user: CurrentUserDto, @Body() data: BulkRejectPostDto) {
    return this.postService.bulkReject(user, data.ids, data.reason);
  }

  // GET /posts/:id/media?key=... — admin, declared before ':id'.
  @Get(':id/media')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: "Admin: get a short-lived download URL for a post's media",
  })
  async getMedia(@Param('id') postId: string, @Query() query: MediaKeyQueryDto) {
    return this.postService.getMediaDownloadUrl(postId, query.key);
  }

  // GET /posts/:id/history — admin.
  @Get(':id/history')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get the audit timeline for one post',
  })
  async getHistory(@Param('id') postId: string) {
    return this.postService.getHistory(postId);
  }

  // GET /posts/:id — admin.
  @Get(':id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get one post',
  })
  async findOne(@Param('id') postId: string) {
    return this.postService.findOne(postId);
  }

  // PATCH /posts/:id/status — validated against the shared transition map.
  @Patch(':id/status')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REVIEW)
  @ApiOperation({
    summary: 'Admin: update post status',
  })
  async updateStatus(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: UpdatePostStatusDto,
  ) {
    return this.postService.updateStatus(user, postId, data.status, data.childSafetyConfirmed);
  }

  // PATCH /posts/:id/approve — requires dual-admin child-safety confirmation.
  @Patch(':id/approve')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_APPROVE)
  @ApiOperation({
    summary: 'Admin: approve a post',
  })
  async approve(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: ApprovePostDto,
  ) {
    return this.postService.approve(user, postId, data);
  }

  // PATCH /posts/:id/claim — marks a post as being handled.
  @Patch(':id/claim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REVIEW)
  @ApiOperation({
    summary: 'Admin: claim a post so others know it is being handled',
  })
  async claim(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.claimPost(user, postId);
  }

  // PATCH /posts/:id/unclaim
  @Patch(':id/unclaim')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REVIEW)
  @ApiOperation({
    summary: 'Admin: release a claim on a post',
  })
  async unclaim(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.unclaimPost(user, postId);
  }

  // PATCH /posts/:id/request-changes — persists the message on the Post row.
  @Patch(':id/request-changes')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REQUEST_CHANGES)
  @ApiOperation({
    summary: 'Admin: request changes to a post',
  })
  async requestChanges(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: RequestPostChangesDto,
  ) {
    return this.postService.requestChanges(user, postId, data);
  }

  // PATCH /posts/:id/publish
  @Patch(':id/publish')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_PUBLISH)
  @ApiOperation({
    summary: 'Admin: publish an approved post',
  })
  async publish(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.publish(user, postId);
  }

  // PATCH /posts/:id/reject — a PUBLISHED post must be unpublished first.
  @Patch(':id/reject')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_REJECT)
  @ApiOperation({
    summary: 'Admin: reject a post',
  })
  async reject(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: RejectPostDto,
  ) {
    return this.postService.reject(user, postId, data);
  }

  // PATCH /posts/:id/unpublish
  @Patch(':id/unpublish')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_UNPUBLISH)
  @ApiOperation({
    summary: 'Admin: unpublish a post',
  })
  async unpublish(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.unpublish(user, postId);
  }
}
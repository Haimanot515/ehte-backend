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
  // --- new ---
  AppealPostDto,
  DecidePostAppealDto,
  FlagPostDto,
  ResolvePostFlagsDto,
  TakedownPostDto,
  UnreadPostsQueryDto,
  PostAuthorRollupQueryDto,
  PostsByAuthorQueryDto,
  FlaggedPostsQueryDto,
  PostAppealsQueryDto,
  PostTimelineQueryDto,
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

  // NEW — GET /posts/me/summary — declared before 'me/:id' so "summary" isn't matched as an id.
  @Get('me/summary')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get my post counts by status (draft, pending, changes requested, published, ...)',
  })
  async getMyPostSummary(@CurrentUser() user: CurrentUserDto) {
    return this.postService.getMyPostSummary(user.id);
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

  // NEW — GET /posts/me/:id/history — author-safe timeline (no internal admin notes).
  @Get('me/:id/history')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the review timeline of one of my posts (author-safe view)',
  })
  async getMyPostHistory(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.getMyPostHistory(user.id, postId);
  }

  // NEW — POST /posts/me/:id/appeal — only for REJECTED or taken-down posts, one open appeal at a time.
  @Post('me/:id/appeal')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Appeal a rejection or takedown of my post',
  })
  async appealMyPost(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: AppealPostDto,
  ) {
    return this.postService.appealMyPost(user.id, postId, data);
  }

  // NEW — GET /posts/me/:id/appeals — my appeals on one post and their outcomes.
  @Get('me/:id/appeals')
  @RequireReauthentication()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List my appeals for one of my posts',
  })
  async findMyPostAppeals(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.findMyPostAppeals(user.id, postId);
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

  // NEW — GET /posts/stats/timeline — totals over time, bucketed by day/week/month.
  @Get('stats/timeline')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({
    summary: 'Admin: get post totals over a timeline, optionally by status, type or author',
  })
  async getStatsTimeline(@Query() query: PostTimelineQueryDto) {
    return this.postService.getStatsTimeline(query);
  }

  // NEW — GET /posts/stats/moderation — open flags, open appeals, takedowns, review turnaround.
  @Get('stats/moderation')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({
    summary: 'Admin: get moderation statistics (flags, appeals, takedowns)',
  })
  async getModerationStats() {
    return this.postService.getModerationStats();
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

  // NEW — GET /posts/unread-count — declared before ':id'. Read state is per admin.
  @Get('unread-count')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Admin: get my read, unread and total post counts',
  })
  async getUnreadCount(@CurrentUser() admin: CurrentUserDto) {
    return this.postService.getUnreadCount(admin);
  }

  // NEW — GET /posts/unread — declared before ':id'.
  @Get('unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Admin: get posts I have not read yet',
  })
  async findUnread(@CurrentUser() admin: CurrentUserDto, @Query() query: UnreadPostsQueryDto) {
    return this.postService.findUnread(admin, query);
  }

  // NEW — GET /posts/by-author — one row per author with totals; declared before ':id'.
  @Get('by-author')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get a rollup of posts per author (totals by status, last post date)',
  })
  async findAuthorRollup(@Query() query: PostAuthorRollupQueryDto) {
    return this.postService.findAuthorRollup(query);
  }

  // NEW — GET /posts/by-author/:authorId — an author may post many times.
  @Get('by-author/:authorId')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: get all posts by one author',
  })
  async findPostsByAuthor(
    @Param('authorId') authorId: string,
    @Query() query: PostsByAuthorQueryDto,
  ) {
    return this.postService.findPostsByAuthor(authorId, query);
  }

  // NEW — GET /posts/flags — posts flagged by users; declared before ':id'.
  @Get('flags')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_FLAG_REVIEW)
  @ApiOperation({
    summary: 'Admin: list flagged posts waiting for review',
  })
  async findFlaggedPosts(@Query() query: FlaggedPostsQueryDto) {
    return this.postService.findFlaggedPosts(query);
  }

  // NEW — GET /posts/appeals — declared before ':id'.
  @Get('appeals')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_APPEAL_DECIDE)
  @ApiOperation({
    summary: 'Admin: list post appeals (default: open)',
  })
  async findAppeals(@Query() query: PostAppealsQueryDto) {
    return this.postService.findAppeals(query);
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

  // NEW — PATCH /posts/bulk/read — declared before ':id/read'.
  @Patch('bulk/read')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: mark several posts as read for me',
  })
  async bulkMarkRead(@CurrentUser() admin: CurrentUserDto, @Body() data: BulkPostIdsDto) {
    return this.postService.bulkMarkRead(admin, data.ids);
  }

  // NEW — PATCH /posts/read-all — marks every currently visible unread post as read for me.
  @Patch('read-all')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: mark all posts as read for me',
  })
  async markAllRead(@CurrentUser() admin: CurrentUserDto) {
    return this.postService.markAllRead(admin);
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

  // NEW — GET /posts/:id/flags — every flag raised on one post.
  @Get(':id/flags')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_FLAG_REVIEW)
  @ApiOperation({
    summary: 'Admin: list the flags raised on one post',
  })
  async findPostFlags(@Param('id') postId: string) {
    return this.postService.findPostFlags(postId);
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

  // NEW — PATCH /posts/:id/read — read state is stored per admin.
  @Patch(':id/read')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: mark a post as read for me',
  })
  async markRead(@CurrentUser() admin: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.markRead(admin, postId);
  }

  // NEW — PATCH /posts/:id/unread
  @Patch(':id/unread')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_READ)
  @ApiOperation({
    summary: 'Admin: mark a post as unread for me',
  })
  async markUnread(@CurrentUser() admin: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.markUnread(admin, postId);
  }

  // NEW — POST /posts/:id/flag — any logged-in user; the service blocks flagging your own post
  // and de-duplicates one flag per user per post.
  @Post(':id/flag')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Flag a published post for review',
  })
  async flag(
    @CurrentUser() user: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: FlagPostDto,
  ) {
    return this.postService.flagPost(user, postId, data);
  }

  // NEW — PATCH /posts/:id/flags/resolve — closes all open flags on a post with an outcome.
  @Patch(':id/flags/resolve')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_FLAG_REVIEW)
  @ApiOperation({
    summary: 'Admin: resolve the open flags on a post (dismissed or actioned)',
  })
  async resolveFlags(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: ResolvePostFlagsDto,
  ) {
    return this.postService.resolveFlags(admin, postId, data);
  }

  // NEW — PATCH /posts/:id/takedown — emergency removal of a PUBLISHED post, reason required.
  // Unlike unpublish, it records the takedown reason, notifies the author and opens the appeal window.
  @Patch(':id/takedown')
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_TAKEDOWN)
  @ApiOperation({
    summary: 'Admin: take down a published post immediately, with a reason',
  })
  async takedown(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') postId: string,
    @Body() data: TakedownPostDto,
  ) {
    return this.postService.takedown(admin, postId, data);
  }

  // NEW — PATCH /posts/:id/appeals/:appealId/decide — uphold or overturn.
  @Patch(':id/appeals/:appealId/decide')
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_APPEAL_DECIDE)
  @ApiOperation({
    summary: 'Admin: decide an appeal (uphold or overturn the rejection/takedown)',
  })
  async decideAppeal(
    @CurrentUser() admin: CurrentUserDto,
    @Param('id') postId: string,
    @Param('appealId') appealId: string,
    @Body() data: DecidePostAppealDto,
  ) {
    return this.postService.decideAppeal(admin, postId, appealId, data);
  }
}

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
import { PostType } from '@prisma/client';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
// NOTE: adjust these two import paths to match your actual file locations —
// same convention as Roles / RolesEnum above.
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
// NOTE: adjust this path to wherever MediaModule actually lives —
// same DTO VictimProfileController already uses for its media routes.
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

  // ─────────────────────────────────────────────
  // CREATE POST
  // POST /posts
  // AUTHENTICATED USER
  // Requires password re-authentication.
  //
  // FIX (item #5): accepts an optional Idempotency-Key
  // header so a client retrying after a dropped response
  // (e.g. a double-tap on a flaky connection) doesn't end
  // up creating two identical posts — PostService.create
  // returns the original post on a repeat key instead.
  // ─────────────────────────────────────────────
  @Post()
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

  // ─────────────────────────────────────────────
  // MY POSTS
  // GET /posts/me
  // AUTHENTICATED USER
  // Requires password re-authentication, sent via
  // X-Reauth-Password header since this is a GET.
  // Response is never cached.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // MY POST
  // GET /posts/me/:id
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // UPDATE MY POST
  // PATCH /posts/me/:id
  //
  // Allowed only while DRAFT or CHANGES_REQUESTED —
  // enforced in PostService.updateMyPost.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────
  @Patch('me/:id')
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

  // ─────────────────────────────────────────────
  // SUBMIT MY POST
  // PATCH /posts/me/:id/submit
  //
  // Moves DRAFT or CHANGES_REQUESTED → PENDING,
  // putting the post in front of admins (PRD §12).
  // Rejects with too_many_pending_posts once the
  // caller already has CONTENT_MAX_PENDING_PER_USER
  // (or POST_MAX_PENDING_PER_USER, if set) posts
  // sitting in PENDING (item #1).
  //
  // AUTHENTICATED USER
  // Requires password re-authentication.
  // ─────────────────────────────────────────────
  @Patch('me/:id/submit')
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submit own post for admin review',
  })
  async submitMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.submitMyPost(user.id, postId);
  }

  // ─────────────────────────────────────────────
  // CANCEL / WITHDRAW MY POST
  // PATCH /posts/me/:id/cancel
  // PENDING → DRAFT.
  //
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────
  @Patch('me/:id/cancel')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Withdraw own pending post back to draft',
  })
  async cancelMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.cancelMyPost(user.id, postId);
  }

  // ─────────────────────────────────────────────
  // DELETE MY POST
  // DELETE /posts/me/:id
  //
  // Scoped to DRAFT only — enforced in
  // PostService.deleteMyPost.
  //
  // AUTHENTICATED USER
  // Requires password re-authentication.
  // ─────────────────────────────────────────────
  @Delete('me/:id')
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Delete own draft post',
  })
  async deleteMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.deleteMyPost(user.id, postId);
  }

  // ─────────────────────────────────────────────
  // PUBLIC POSTS
  // GET /posts/published
  // ANONYMOUS
  //
  // FIX (item #7): responses no longer include the
  // poster's userId — see PostService.toPublicPost.
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // PUBLIC POST — MEDIA DOWNLOAD URL
  // GET /posts/published/:id/media?key=...
  //
  // Returns only a key that getPubliclyVisibleMediaKeys() would
  // actually expose — i.e. never a child-involving post's media,
  // never an unpublished post's media at all (findFirst's WHERE
  // 404s first). Same visibility contract as findPublishedPost().
  //
  // Declared BEFORE 'published/:id' so Nest matches this more
  // specific path first — route order matters here.
  // ANONYMOUS
  // ─────────────────────────────────────────────
  @Get('published/:id/media')
  @AllowAnonymous()
  @ApiOperation({
    summary: "Get a short-lived download URL for a published post's media",
  })
  async getPublicMedia(@Param('id') postId: string, @Query() query: MediaKeyQueryDto) {
    return this.postService.getPublicMediaDownloadUrl(postId, query.key);
  }

  // ─────────────────────────────────────────────
  // PUBLIC POST
  // GET /posts/published/:id
  // ANONYMOUS
  //
  // FIX (item #7): response no longer includes the
  // poster's userId — see PostService.toPublicPost.
  // ─────────────────────────────────────────────
  @Get('published/:id')
  @AllowAnonymous()
  @ApiOperation({
    summary: 'Get one published public post',
  })
  async findPublishedPost(@Param('id') postId: string) {
    return this.postService.findPublishedPost(postId);
  }

  // ─────────────────────────────────────────────
  // ADMIN — CREATE OFFICIAL POST
  // POST /posts/official
  //
  // Distinct from POST /posts: attributed to the
  // admin as author. When publishImmediately=true
  // (default) AND involvesChild=true,
  // childSafetyConfirmed=true is required in the
  // body — enforced in PostService.createOfficial.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Post('official')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.POST_CREATE_OFFICIAL)
  @ApiOperation({
    summary: 'Admin: create an official post',
  })
  async createOfficial(@CurrentUser() user: CurrentUserDto, @Body() data: AdminCreatePostDto) {
    return this.postService.createOfficial(user, data);
  }

  // ─────────────────────────────────────────────
  // ADMIN — ALL POSTS
  // GET /posts
  //
  // Filters/pagination via AdminPostQueryDto (status,
  // type, involvesChild, authorId, page, limit).
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — STALE / UNREVIEWED-TOO-LONG POSTS
  // GET /posts/stale
  // (item #9)
  //
  // Declared BEFORE ':id' so Nest doesn't treat
  // "stale" as a post id — same reasoning as the
  // published/:id/media route above.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — BULK APPROVE
  // PATCH /posts/bulk/approve
  // (item #8)
  //
  // Declared BEFORE ':id/approve' so Nest doesn't
  // match "bulk" as a post id here — route order
  // matters, same as elsewhere in this controller.
  // Any involvesChild post in the batch is skipped
  // and reported back as requiring individual review.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — BULK REJECT
  // PATCH /posts/bulk/reject
  // (item #8)
  //
  // Declared BEFORE ':id/reject' — same route-order
  // reasoning as bulk/approve above.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — GET MEDIA DOWNLOAD URL
  // GET /posts/:id/media?key=...
  //
  // Admins can request a download URL for any media key actually
  // attached to the post, regardless of status — same admin-only,
  // no-visibility-filtering access as findOne().
  //
  // Declared BEFORE ':id' so Nest matches this more specific path
  // first — route order matters here.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — PER-POST HISTORY / TIMELINE
  // GET /posts/:id/history
  // (item #13)
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — ONE POST
  // GET /posts/:id
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — UPDATE STATUS
  // PATCH /posts/:id/status
  //
  // Takes UpdatePostStatusDto so the status value is
  // DTO-validated (@IsEnum) like every other write
  // endpoint. Every transition is also validated
  // against the shared status-transition map, the
  // claim guard (#11), and the child-safety
  // dual-control gate (#10).
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — APPROVE
  // PATCH /posts/:id/approve
  //
  // Requires childSafetyConfirmed=true in the body
  // when the post has involvesChild = true (PRD §32),
  // and now requires two DIFFERENT admins to each send
  // it before the post actually becomes APPROVED
  // (item #10) — enforced in PostService.approve.
  // Blocked if the post is claimed by a different
  // admin (item #11).
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — CLAIM
  // PATCH /posts/:id/claim
  // (item #11)
  //
  // Lets an admin mark a post as "being handled" so a
  // second admin doesn't start reviewing it in parallel.
  // Idempotent for the same admin; rejected if already
  // claimed by someone else.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — UNCLAIM
  // PATCH /posts/:id/unclaim
  // (item #11)
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — REQUEST CHANGES
  // PATCH /posts/:id/request-changes
  //
  // PRD §24: "Request changes" (Posts). Persists the
  // message on the Post row itself in addition to the
  // audit log and notification.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — PUBLISH
  // PATCH /posts/:id/publish
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — REJECT
  // PATCH /posts/:id/reject
  //
  // Takes RejectPostDto so the owner is told why,
  // mirroring request-changes and PRD §40's
  // transparency principle. Blocks rejecting a
  // PUBLISHED post directly — it must be unpublished
  // first, via the shared transition map — and
  // persists the reason on the Post row itself.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // ADMIN — UNPUBLISH
  // PATCH /posts/:id/unpublish
  //
  // Notifies the post owner, matching
  // approve/reject/request-changes.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
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
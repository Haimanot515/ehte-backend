import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PostType } from '@prisma/client';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
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
  // ─────────────────────────────────────────────
  @Post()
  @RequireReauthentication()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a new post',
  })
  async create(@CurrentUser() user: CurrentUserDto, @Body() data: CreatePostDto) {
    return this.postService.create(user.id, data);
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
  //
  // FIX (#15) — added @RequireReauthentication() to
  // match findMyPosts. Previously the list view
  // required re-auth to see your own posts, but the
  // detail view for a single post — same class of
  // data — didn't, which was a weaker-gated way to
  // reach identical information.
  //
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
  // FIX (#4) — CANCEL / WITHDRAW MY POST
  // PATCH /posts/me/:id/cancel
  //
  // PENDING → DRAFT. Previously an owner had no way
  // to pull a submitted post back before an admin
  // acted on it.
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
  // FIX (#5) — DELETE MY POST
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
  // PUBLIC POST
  // GET /posts/published/:id
  // ANONYMOUS
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
  // childSafetyConfirmed=true is now required in the
  // body — enforced in PostService.createOfficial.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Post('official')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // ADMIN — ONE POST
  // GET /posts/:id
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Get(':id')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // FIX (#1/#12/#13) — now takes UpdatePostStatusDto
  // instead of reading @Body('status') raw, so the
  // status value is DTO-validated (@IsEnum) like
  // every other write endpoint. The DTO also carries
  // an optional childSafetyConfirmed, which
  // PostService.updateStatus now requires whenever
  // the transition target is APPROVED/PUBLISHED on an
  // involvesChild post — closing the bypass this
  // endpoint previously had around approve()'s gate.
  // Every transition is also validated against the
  // shared status-transition map, so this endpoint
  // can no longer skip steps a dedicated endpoint
  // wouldn't allow (e.g. DRAFT straight to PUBLISHED).
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Patch(':id/status')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // when the post has involvesChild = true (PRD §32)
  // — enforced in PostService.approve. Also now
  // blocks approving a DRAFT post that was never
  // submitted, via the shared transition map.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Patch(':id/approve')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // ADMIN — REQUEST CHANGES
  // PATCH /posts/:id/request-changes
  //
  // PRD §24: "Request changes" (Posts). Now blocks
  // requesting changes on a DRAFT (never submitted)
  // via the shared transition map, and persists the
  // message on the Post row itself in addition to the
  // audit log and notification.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Patch(':id/request-changes')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // transparency principle. Now blocks rejecting a
  // PUBLISHED post directly — it must be unpublished
  // first, via the shared transition map — and
  // persists the reason on the Post row itself.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Patch(':id/reject')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
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
  // Now notifies the post owner, matching
  // approve/reject/request-changes.
  //
  // ADMIN / SUPER_ADMIN
  // ─────────────────────────────────────────────
  @Patch(':id/unpublish')
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin: unpublish a post',
  })
  async unpublish(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.unpublish(user, postId);
  }
}
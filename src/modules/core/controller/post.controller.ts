import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PostStatus, PostType } from '@prisma/client';
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
  // AUTHENTICATED USER
  // ─────────────────────────────────────────────
  @Get('me/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one post created by current user',
  })
  async findMyPost(@CurrentUser() user: CurrentUserDto, @Param('id') postId: string) {
    return this.postService.findMyPost(user.id, postId);
  }
  // ─────────────────────────────────────────────
  // Added — UPDATE MY POST
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
  // Added — SUBMIT MY POST
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
  // PUBLIC POSTS
  // GET /posts/published
  //
  // Modified — added optional ?type= filter so
  // Incident Posts (PRD §12) and Awareness Posts
  // (§13) can be browsed separately.
  //
  // Modified — now paginated (PRD §30, low-bandwidth
  // requirements). This is the one anonymous public
  // endpoint here, so it's the most exposed to
  // unbounded growth and the most important to keep
  // lightweight.
  //
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
  // Added — ADMIN — CREATE OFFICIAL POST
  // POST /posts/official
  //
  // PRD §13: "Authorized administrators can create
  // official Posts." Distinct from POST /posts: the
  // resulting post is attributed to the admin as
  // author, and by default (publishImmediately=true)
  // is created straight into APPROVED, since admin
  // authorship is itself the review step. Passing
  // publishImmediately=false routes it through the
  // normal PENDING → approve/reject/request-changes
  // flow instead, for cases where an admin drafts on
  // someone else's behalf but still wants a second
  // reviewer.
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
  // Modified — now accepts filters/pagination via
  // AdminPostQueryDto (status, type, involvesChild,
  // page, limit), matching AdminReportQueryDto.
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
  // Kept as-is, unchanged. Note: this route can
  // still set any PostStatus directly (including
  // skipping straight to PUBLISHED, or setting
  // CHANGES_REQUESTED without a message), which is
  // the workflow-bypass gap flagged earlier. Left
  // untouched per your instruction — let me know if
  // you want it locked down or removed later.
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
    @Body('status') status: PostStatus,
  ) {
    return this.postService.updateStatus(user, postId, status);
  }
  // ─────────────────────────────────────────────
  // ADMIN — APPROVE
  // PATCH /posts/:id/approve
  //
  // Modified — now takes a body (ApprovePostDto).
  // Required when the post has involvesChild = true
  // (PRD §32) — enforced in PostService.approve.
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
  // Added — ADMIN — REQUEST CHANGES
  // PATCH /posts/:id/request-changes
  //
  // PRD §24: "Request changes" (Posts).
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
  // Modified — now takes a body (RejectPostDto) so
  // the owner is told why, mirroring request-changes
  // and PRD §40's transparency principle.
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

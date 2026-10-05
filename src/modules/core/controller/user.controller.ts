import { MediaUpload, PROFILE_PICTURE_FIELDS } from 'src/common/decorators/media-upload.decorator';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequireReauthentication } from 'src/common/decorators/reauth.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';

import {
  AdminActionReasonDto,
  AdminChangePhoneDto,
  AdminRequiredReasonDto,
  AdminUpdateDiscreetModeDto,
  AdminUpdateUserDto,
  AssignUserRoleDto,
  BulkRestrictionDto,
  BulkUserIdsDto,
  BulkUserReasonDto,
  BulkWarningDto,
  ChangePhoneInitiateDto,
  ChangePhoneVerifyDto,
  CreateRestrictionDto,
  CreateWarningDto,
  DecideDeletionRequestDto,
  InactiveUsersQueryDto,
  LegalHoldDto,
  ListDeleteRequestsQueryDto,
  ListUsersQueryDto,
  MergeUserDto,
  RequestAccountDeletionDto,
  ResendPhoneOtpDto,
  UpdateDiscreetModeDto,
  UpdateLanguageDto,
  UpdateProfilePictureDto,
  UpdateUserDto,
  UserExportQueryDto,
  UserSearchQueryDto,
  UsersPagedQueryDto,
  UserStatsQueryDto,
  UserStatsTimelineQueryDto,
} from '../dto/user.dto';
import { UserService } from '../service/user.service';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ── SELF-SERVICE ── literal 'me/...' routes, before any ':id' route.

  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  async getMe(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMe(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update my profile' })
  async updateMe(@CurrentUser() user: CurrentUserDto, @Body() data: UpdateUserDto) {
    return this.userService.updateMe(user, data);
  }

  // Re-auth required: password when disabling, password or current
  // passcode when enabling — see UserService.updateDiscreetMode.
  @Patch('me/discreet-mode')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Enable, disable, or change the passcode for Discreet Mode' })
  async updateDiscreetMode(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: UpdateDiscreetModeDto,
  ) {
    return this.userService.updateDiscreetMode(user, data);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Deactivate my account' })
  async deactivateMe(@CurrentUser() user: CurrentUserDto) {
    return this.userService.deactivateMe(user);
  }

  @Get('me/audit-log')
  @ApiOperation({ summary: 'My own audit history (logins, profile changes, etc.)' })
  async getMyAuditLog(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getHistory(user.id);
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'List my active sessions/devices' })
  async getMySessions(@CurrentUser() user: CurrentUserDto) {
    return this.userService.listSessions(user.id);
  }

  @Delete('me/sessions/:sessionId')
  @ApiOperation({ summary: 'Revoke one of my sessions (e.g. log out an old device)' })
  @ApiParam({ name: 'sessionId', description: 'Id of the session to revoke' })
  async revokeMySession(
    @CurrentUser() user: CurrentUserDto,
    @Param('sessionId') sessionId: string,
  ) {
    return this.userService.revokeSession(user, user.id, sessionId);
  }

  // OTP-gated phone change — mirrors AdminAuthService's email-change flow.
  @Post('me/change-phone/initiate')
  @ApiOperation({ summary: 'Step 1: request an OTP to move my account to a new phone number' })
  async changePhoneInitiate(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: ChangePhoneInitiateDto,
  ) {
    return this.userService.changePhoneInitiate(user, data);
  }

  @Post('me/change-phone/verify')
  @ApiOperation({ summary: 'Step 2: verify the OTP and complete the phone number change' })
  async changePhoneVerify(@CurrentUser() user: CurrentUserDto, @Body() data: ChangePhoneVerifyDto) {
    return this.userService.changePhoneVerify(user, data);
  }

  // Upload to MinIO via presigned URL first, then call these with the key.
  @Get('me/profile-picture')
  @ApiOperation({ summary: 'Get a presigned download URL for my profile picture' })
  async getMyProfilePicture(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getProfilePictureUrl(user);
  }

  @Patch('me/profile-picture')
  @MediaUpload(UpdateProfilePictureDto, PROFILE_PICTURE_FIELDS)
  @ApiOperation({ summary: 'Set/replace my profile picture (after uploading to MinIO)' })
  async updateMyProfilePicture(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: UpdateProfilePictureDto,
  ) {
    return this.userService.updateProfilePicture(user, data);
  }

  @Delete('me/profile-picture')
  @ApiOperation({ summary: 'Remove my profile picture' })
  async removeMyProfilePicture(@CurrentUser() user: CurrentUserDto) {
    return this.userService.removeProfilePicture(user);
  }

  // ── SELF-SERVICE (more) ── still literal "me/..." routes, declared above every ":id" route.

  // US-01
  @Get('me/data-export')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Download all my account data in one file' })
  async getMyDataExport(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMyDataExport(user);
  }

  // US-02
  @Post('me/delete-request')
  @RequireReauthentication()
  @ApiOperation({ summary: 'Request permanent deletion of my account (waiting period applies)' })
  async requestMyDeletion(
    @CurrentUser() user: CurrentUserDto,
    @Body() data: RequestAccountDeletionDto,
  ) {
    return this.userService.requestMyDeletion(user, data);
  }

  // US-03
  @Delete('me/delete-request')
  @ApiOperation({ summary: 'Cancel my pending deletion request' })
  async cancelMyDeletionRequest(@CurrentUser() user: CurrentUserDto) {
    return this.userService.cancelMyDeletionRequest(user);
  }

  // US-04
  @Get('me/delete-request')
  @ApiOperation({ summary: 'Status of my deletion request' })
  async getMyDeletionRequest(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMyDeletionRequest(user);
  }

  // US-05
  @Delete('me/sessions')
  @ApiOperation({ summary: 'Sign out all my other devices' })
  async revokeMyOtherSessions(@CurrentUser() user: CurrentUserDto) {
    return this.userService.revokeMyOtherSessions(user);
  }

  // US-06
  @Get('me/login-history')
  @ApiOperation({ summary: 'My recent sign-ins with device, time and coarse location' })
  async getMyLoginHistory(@CurrentUser() user: CurrentUserDto, @Query() query: UsersPagedQueryDto) {
    return this.userService.getMyLoginHistory(user, query);
  }

  // US-07
  @Get('me/security-events')
  @ApiOperation({ summary: 'Password changes, phone changes and failed sign-ins on my account' })
  async getMySecurityEvents(
    @CurrentUser() user: CurrentUserDto,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getMySecurityEvents(user, query);
  }

  // US-08
  @Get('me/summary')
  @ApiOperation({ summary: 'My counts: reports, posts, supports, payments' })
  async getMySummary(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMySummary(user);
  }

  // US-09
  @Get('me/discreet-mode')
  @ApiOperation({ summary: 'Read my Discreet Mode setting' })
  async getMyDiscreetMode(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMyDiscreetMode(user);
  }

  // US-10
  @Get('me/linked-accounts')
  @ApiOperation({ summary: 'Social accounts linked to mine' })
  async getMyLinkedAccounts(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMyLinkedAccounts(user);
  }

  // US-11
  @Delete('me/linked-accounts/:provider')
  @ApiOperation({ summary: 'Unlink a social account (needs another way to sign in)' })
  @ApiParam({ name: 'provider', description: 'Linked provider: google, facebook or apple' })
  async unlinkMyAccount(@CurrentUser() user: CurrentUserDto, @Param('provider') provider: string) {
    return this.userService.unlinkMyAccount(user, provider);
  }

  // US-12
  @Get('me/consents')
  @ApiOperation({ summary: 'Terms and privacy versions I accepted, with dates' })
  async getMyConsents(@CurrentUser() user: CurrentUserDto) {
    return this.userService.getMyConsents(user);
  }

  // US-13
  @Patch('me/language')
  @ApiOperation({ summary: 'Set my preferred language' })
  async updateMyLanguage(@CurrentUser() user: CurrentUserDto, @Body() data: UpdateLanguageDto) {
    return this.userService.updateMyLanguage(user, data);
  }

  // US-14
  @Post('me/change-phone/resend-otp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend the code for a pending phone change' })
  async resendChangePhoneOtp(@CurrentUser() user: CurrentUserDto, @Body() data: ResendPhoneOtpDto) {
    return this.userService.resendChangePhoneOtp(user, data);
  }

  // ── ADMIN ── literal routes ('stats') registered before ':id' routes.

  @Get()
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'List all users (admin)' })
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.userService.listUsers(query);
  }

  @Get('stats')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User-related dashboard stats' })
  async getDashboardStats() {
    return this.userService.getDashboardStats();
  }

  // ── ADMIN ── literal routes (restricted, locked, search, export, bulk/*, stats/* ...) kept above every ":id" route.

  // US-30
  @Get('restricted')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'List users with an active restriction (admin)' })
  async listRestricted(@CurrentUser() actor: CurrentUserDto, @Query() query: UsersPagedQueryDto) {
    return this.userService.listRestricted(actor, query);
  }

  // US-31
  @Get('locked')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'List users locked after failed sign-ins (admin)' })
  async listLocked(@CurrentUser() actor: CurrentUserDto, @Query() query: UsersPagedQueryDto) {
    return this.userService.listLocked(actor, query);
  }

  // US-46
  @Get('inactive')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'List accounts with no sign-in for a chosen period (admin)' })
  async listInactive(@CurrentUser() actor: CurrentUserDto, @Query() query: InactiveUsersQueryDto) {
    return this.userService.listInactive(actor, query);
  }

  // US-48
  @Get('duplicates')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Suspected duplicate accounts by phone, device or name (admin)' })
  async listDuplicates(@CurrentUser() actor: CurrentUserDto, @Query() query: UsersPagedQueryDto) {
    return this.userService.listDuplicates(actor, query);
  }

  // US-33
  @Get('abuse-reports')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Queue of user abuse reports (admin)' })
  async listAbuseReports(@CurrentUser() actor: CurrentUserDto, @Query() query: UsersPagedQueryDto) {
    return this.userService.listAbuseReports(actor, query);
  }

  // US-40
  @Get('delete-requests')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_DELETE)
  @ApiOperation({ summary: 'Queue of account deletion requests with their waiting period (admin)' })
  async listDeleteRequests(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: ListDeleteRequestsQueryDto,
  ) {
    return this.userService.listDeleteRequests(actor, query);
  }

  // US-41
  @Patch('delete-requests/:requestId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_DELETE)
  @ApiOperation({ summary: 'Approve, delay or decline a deletion request (admin)' })
  @ApiParam({ name: 'requestId', description: 'Id of the deletion request' })
  async decideDeleteRequest(
    @CurrentUser() actor: CurrentUserDto,
    @Param('requestId') requestId: string,
    @Body() data: DecideDeletionRequestDto,
  ) {
    return this.userService.decideDeleteRequest(actor, requestId, data);
  }

  // US-54
  @Get('search')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Find users by reference, name or phone, masked by role (admin)' })
  async searchUsers(@CurrentUser() actor: CurrentUserDto, @Query() query: UserSearchQueryDto) {
    return this.userService.searchUsers(actor, query);
  }

  // US-55
  @Get('facets')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Counts for the user filter sidebar (admin)' })
  async getUserFacets(@CurrentUser() actor: CurrentUserDto, @Query() query: UserStatsQueryDto) {
    return this.userService.getUserFacets(actor, query);
  }

  // US-56
  @Get('filters/options')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Dropdown values for user filters (admin)' })
  async getUserFilterOptions(@CurrentUser() actor: CurrentUserDto) {
    return this.userService.getUserFilterOptions(actor);
  }

  // US-57
  @Get('export')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ, PermissionsEnum.USER_EXPORT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Export users as CSV (row-capped, masked, audited)' })
  async exportUsersCsv(@CurrentUser() actor: CurrentUserDto, @Query() query: UserExportQueryDto) {
    return this.userService.exportUsersCsv(actor, query);
  }

  // US-58
  @Post('export-jobs')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_EXPORT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireReauthentication()
  @ApiOperation({ summary: 'Start a background user export' })
  async createUserExportJob(
    @CurrentUser() actor: CurrentUserDto,
    @Body() data: UserExportQueryDto,
  ) {
    return this.userService.createUserExportJob(actor, data);
  }

  // US-59
  @Get('export-jobs/:id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_EXPORT)
  @ApiOperation({ summary: 'Progress of a user export job' })
  @ApiParam({ name: 'id', description: 'Id of the export job' })
  async getUserExportJob(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserExportJob(actor, id);
  }

  // US-60
  @Get('export-jobs/:id/download')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_EXPORT)
  @ApiOperation({ summary: 'Short-lived download link for a finished export (audited)' })
  @ApiParam({ name: 'id', description: 'Id of the export job' })
  async getUserExportJobDownload(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserExportJobDownload(actor, id);
  }

  // US-34
  @Post('bulk/force-logout')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({ summary: 'Sign out many users, for example after an incident (admin)' })
  async bulkForceLogout(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkUserIdsDto) {
    return this.userService.bulkForceLogout(actor, data);
  }

  // US-35
  @Patch('bulk/deactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Deactivate many users with a reason (admin)' })
  async bulkDeactivate(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkUserReasonDto) {
    return this.userService.bulkDeactivate(actor, data);
  }

  // US-36
  @Patch('bulk/reactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({ summary: 'Reactivate many users (admin)' })
  async bulkReactivate(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkUserIdsDto) {
    return this.userService.bulkReactivate(actor, data);
  }

  // US-37
  @Patch('bulk/unlock')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UNLOCK)
  @ApiOperation({ summary: 'Unlock many users (admin)' })
  async bulkUnlock(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkUserIdsDto) {
    return this.userService.bulkUnlock(actor, data);
  }

  // US-38
  @Post('bulk/warnings')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Send one warning to many users (admin)' })
  async bulkWarn(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkWarningDto) {
    return this.userService.bulkWarn(actor, data);
  }

  // US-39
  @Post('bulk/restrictions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Apply one restriction to many users (admin)' })
  async bulkRestrict(@CurrentUser() actor: CurrentUserDto, @Body() data: BulkRestrictionDto) {
    return this.userService.bulkRestrict(actor, data);
  }

  // US-61
  @Get('stats/timeline')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: signups per day, week or month' })
  async getUserStatsTimeline(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsTimelineQueryDto,
  ) {
    return this.userService.getUserStatsTimeline(actor, query);
  }

  // US-62
  @Get('stats/active')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: daily and monthly active users' })
  async getUserStatsActive(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsActive(actor, query);
  }

  // US-63
  @Get('stats/by-role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: users by role' })
  async getUserStatsByRole(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsByRole(actor, query);
  }

  // US-64
  @Get('stats/by-region')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: users by region' })
  async getUserStatsByRegion(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsByRegion(actor, query);
  }

  // US-65
  @Get('stats/verification-funnel')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: signup started, code sent, verified, active' })
  async getUserStatsVerificationFunnel(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsVerificationFunnel(actor, query);
  }

  // US-66
  @Get('stats/retention')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: share of signups still active after 7, 30 and 90 days' })
  async getUserStatsRetention(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsRetention(actor, query);
  }

  // US-67
  @Get('stats/deactivations')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: deactivations and deletions over time, with reasons' })
  async getUserStatsDeactivations(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsDeactivations(actor, query);
  }

  // US-68
  @Get('stats/login-failures')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: failed sign-ins and lockouts over time' })
  async getUserStatsLoginFailures(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsLoginFailures(actor, query);
  }

  // US-69
  @Get('stats/restrictions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: restrictions and warnings over time' })
  async getUserStatsRestrictions(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsRestrictions(actor, query);
  }

  // US-70
  @Get('stats/overview')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.DASHBOARD_READ)
  @ApiOperation({ summary: 'User stats: dashboard in one call' })
  async getUserStatsOverview(
    @CurrentUser() actor: CurrentUserDto,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserStatsOverview(actor, query);
  }

  @Get(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Get a single user by id (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user to fetch' })
  async getUserById(@Param('id') id: string) {
    return this.userService.getUserById(id);
  }

  // Fix a user's name/address/demographic details. Never touches role, email,
  // phone or active status: those have their own guarded routes.
  @Patch(':id')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @ApiOperation({ summary: "Update a user's profile details (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose profile is being updated' })
  async adminUpdateUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminUpdateUserDto,
  ) {
    return this.userService.adminUpdateUser(actor, id, data, data.reason);
  }

  @Get(':id/audit-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's full audit history (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose history is being read' })
  async getUserAuditLog(@Param('id') id: string) {
    return this.userService.getHistory(id);
  }

  @Get(':id/sessions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "List a user's active sessions/devices (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose sessions are being listed' })
  async getUserSessions(@Param('id') id: string) {
    return this.userService.listSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({ summary: "Revoke one specific session of a user's (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user who owns the session' })
  @ApiParam({ name: 'sessionId', description: 'Id of the session to revoke' })
  async revokeUserSession(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.userService.revokeSession(actor, id, sessionId);
  }

  // NOT the way to create an admin. ADMIN goes through the email-verified
  // promote flow (POST /admin/auth/promote). This route only escalates an
  // existing, verified ADMIN to SUPER_ADMIN, and re-auth is required.
  @Patch(':id/role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Escalate an existing verified ADMIN to SUPER_ADMIN (does not create admins)',
  })
  @ApiParam({ name: 'id', description: 'Id of the admin being made super_admin' })
  async assignRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AssignUserRoleDto,
  ) {
    return this.userService.assignRole(actor, id, data, data.reason);
  }

  @Delete(':id/role/:role')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.ROLE_UPDATE)
  @ApiOperation({ summary: "Revoke an admin or super_admin role from a user's account" })
  @ApiParam({ name: 'id', description: 'Id of the user being revoked the role' })
  @ApiParam({ name: 'role', enum: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] })
  async revokeRole(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Param('role') role: RolesEnum.ADMIN | RolesEnum.SUPER_ADMIN,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.revokeRole(actor, id, role, body?.reason);
  }

  @Patch(':id/deactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: "Deactivate a user's account (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being deactivated' })
  async deactivateUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.deactivateUser(actor, id, body?.reason);
  }

  @Patch(':id/reactivate')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({ summary: "Reactivate a user's account (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being reactivated' })
  async reactivateUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.reactivateUser(actor, id, body?.reason);
  }

  @Patch(':id/unlock')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UNLOCK)
  @ApiOperation({ summary: "Clear a user's login lockout (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user being unlocked' })
  async unlockUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.unlockUser(actor, id, body?.reason);
  }

  @Post(':id/force-logout')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @ApiOperation({ summary: "Revoke all of a user's active sessions (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose sessions are being revoked' })
  async forceLogout(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() body?: AdminActionReasonDto,
  ) {
    return this.userService.forceLogout(actor, id, body?.reason);
  }

  // Re-auth confirms the ADMIN's own password, not the target's passcode.
  @Patch(':id/discreet-mode')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @RequireReauthentication()
  @ApiOperation({ summary: "Enable, disable, or change a user's Discreet Mode passcode (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user whose Discreet Mode is being configured' })
  async adminUpdateDiscreetMode(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminUpdateDiscreetModeDto,
  ) {
    return this.userService.adminUpdateDiscreetMode(actor, id, data, data.reason);
  }

  // ── ADMIN ── routes under ":id".

  // US-15
  @Get(':id/summary')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({
    summary: "A user's counts: reports, posts, supports, payments, open flags (admin)",
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserSummary(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserSummary(actor, id);
  }

  // US-16
  @Get(':id/timeline')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's account events in order (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserTimeline(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getUserTimeline(actor, id, query);
  }

  // US-17
  @Get(':id/security-events')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({
    summary: "A user's password and phone changes, failed sign-ins and locks (admin)",
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserSecurityEvents(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getUserSecurityEvents(actor, id, query);
  }

  // US-18
  @Get(':id/login-history')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's recent sign-ins with device and coarse location (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserLoginHistory(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getUserLoginHistory(actor, id, query);
  }

  // US-19
  @Get(':id/devices')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's devices and push tokens, masked (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserDevices(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserDevices(actor, id);
  }

  // US-20
  @Get(':id/activity')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Counts of content a user created over time (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserActivity(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UserStatsQueryDto,
  ) {
    return this.userService.getUserActivity(actor, id, query);
  }

  // US-21
  @Get(':id/permissions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's effective permissions, for support checks (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserPermissions(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserPermissions(actor, id);
  }

  // US-22
  @Get(':id/flags')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({
    summary: 'Flags, abuse reports and warnings against a user across modules (admin)',
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserFlags(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getUserFlags(actor, id, query);
  }

  // US-23
  @Post(':id/force-password-reset')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_FORCE_LOGOUT)
  @RequireReauthentication()
  @ApiOperation({
    summary: "Invalidate a compromised account's password and force a reset (admin)",
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async forcePasswordReset(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.forcePasswordReset(actor, id, data);
  }

  // US-24
  @Post(':id/reveal-contact')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ, PermissionsEnum.USER_PII_READ)
  @RequireReauthentication()
  @ApiOperation({ summary: "Show a user's full phone number once, with a reason (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async revealContact(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.revealContact(actor, id, data);
  }

  // US-25
  @Post(':id/restrictions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Block one ability for a user, with a reason and end date (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async createRestriction(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateRestrictionDto,
  ) {
    return this.userService.createRestriction(actor, id, data);
  }

  // US-26
  @Get(':id/restrictions')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's active and past restrictions (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getRestrictions(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getRestrictions(actor, id, query);
  }

  // US-27
  @Delete(':id/restrictions/:restrictionId')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({ summary: 'Lift a restriction early, with a reason (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  @ApiParam({ name: 'restrictionId', description: 'Id of the restriction' })
  async liftRestriction(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Param('restrictionId') restrictionId: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.liftRestriction(actor, id, restrictionId, data);
  }

  // US-28
  @Post(':id/warnings')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Send a recorded warning to a user (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async createWarning(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: CreateWarningDto,
  ) {
    return this.userService.createWarning(actor, id, data);
  }

  // US-29
  @Get(':id/warnings')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "A user's warning history (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getWarnings(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getWarnings(actor, id, query);
  }

  // US-32
  @Patch(':id/deactivate-with-reason')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_SUSPEND)
  @ApiOperation({ summary: 'Deactivate a user with a reason shown in the audit log (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async deactivateUserWithReason(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.deactivateUserWithReason(actor, id, data);
  }

  // US-42
  @Post(':id/anonymize')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_DELETE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Remove identifying fields while keeping records (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async anonymizeUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.anonymizeUser(actor, id, data);
  }

  // US-43
  @Get(':id/erasure-preview')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_DELETE)
  @ApiOperation({ summary: 'Show what would be removed or kept before erasure (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getErasurePreview(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getErasurePreview(actor, id);
  }

  // US-44
  @Patch(':id/legal-hold')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_DELETE)
  @ApiOperation({
    summary: 'Place or lift a legal hold that blocks deletion and anonymization (admin)',
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async setUserLegalHold(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: LegalHoldDto,
  ) {
    return this.userService.setUserLegalHold(actor, id, data);
  }

  // US-45
  @Get(':id/access-log')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: "Who viewed a user's record in the admin area (admin)" })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserAccessLog(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Query() query: UsersPagedQueryDto,
  ) {
    return this.userService.getUserAccessLog(actor, id, query);
  }

  // US-47
  @Post(':id/restore-deleted')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_RESTORE)
  @ApiOperation({ summary: 'Restore an account inside the deletion grace period (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async restoreDeletedUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminActionReasonDto,
  ) {
    return this.userService.restoreDeletedUser(actor, id, data);
  }

  // US-49
  @Get(':id/possible-duplicates')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Likely duplicates of one account (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getPossibleDuplicates(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getPossibleDuplicates(actor, id);
  }

  // US-50
  @Post(':id/merge')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @RequireReauthentication()
  @ApiOperation({ summary: 'Merge a duplicate account into this one (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async mergeUser(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: MergeUserDto,
  ) {
    return this.userService.mergeUser(actor, id, data);
  }

  // US-51
  @Patch(':id/phone-verified')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @ApiOperation({ summary: 'Mark a phone verified after a support check (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async markPhoneVerified(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminRequiredReasonDto,
  ) {
    return this.userService.markPhoneVerified(actor, id, data);
  }

  // US-52
  @Patch(':id/phone')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_UPDATE)
  @RequireReauthentication()
  @ApiOperation({
    summary: 'Change a phone number on a support request, with a code to the new number (admin)',
  })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async adminChangePhone(
    @CurrentUser() actor: CurrentUserDto,
    @Param('id') id: string,
    @Body() data: AdminChangePhoneDto,
  ) {
    return this.userService.adminChangePhone(actor, id, data);
  }

  // US-53
  @Get(':id/verification')
  @Roles(RolesEnum.SUPER_ADMIN)
  @RequirePermissions(PermissionsEnum.USER_READ)
  @ApiOperation({ summary: 'Verification state: phone, email, identity checks (admin)' })
  @ApiParam({ name: 'id', description: 'Id of the user' })
  async getUserVerification(@CurrentUser() actor: CurrentUserDto, @Param('id') id: string) {
    return this.userService.getUserVerification(actor, id);
  }
}
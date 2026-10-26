import { Body, Controller, Delete, Get, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { FollowableEntity } from 'src/common/enums/shared/followable-entity.enum';
import { FollowsService } from '../service/follows.service';
import { CreateFollowDto, FollowListQueryDto, UpdateFollowSettingsDto } from '../dto/follows.dto';

/**
 * FOLLOW A RECORD (SH-19 to SH-24) — missing-person cases and victim profiles only.
 * Follow notifications honour discreet mode and never contain names (enforced in the service).
 *
 * ROUTE ORDER: the plain 'follows' routes come first, then ':entity/:entityId/status'.
 * The class has no prefix because SH-24 is under 'admin/follows'.
 */
@ApiTags('Follows')
@ApiBearerAuth('access-token')
@Controller()
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  // SH-19
  @Post('follows')
  @ApiOperation({ summary: 'Follow a case or profile to receive updates' })
  follow(@CurrentUser() user: CurrentUserDto, @Body() body: CreateFollowDto) {
    return this.follows.follow(user, body);
  }

  // SH-21
  @Get('follows')
  @ApiOperation({ summary: 'List what I follow' })
  list(@CurrentUser() user: CurrentUserDto, @Query() q: FollowListQueryDto) {
    return this.follows.list(user, q);
  }

  // SH-20
  @Delete('follows/:entity/:entityId')
  @ApiOperation({ summary: 'Stop following a record' })
  @ApiParam({ name: 'entity', enum: FollowableEntity })
  unfollow(
    @CurrentUser() user: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(FollowableEntity)) entity: FollowableEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.follows.unfollow(user, entity, entityId);
  }

  // SH-22
  @Get('follows/:entity/:entityId/status')
  @ApiOperation({ summary: 'Whether I follow one record' })
  @ApiParam({ name: 'entity', enum: FollowableEntity })
  status(
    @CurrentUser() user: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(FollowableEntity)) entity: FollowableEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.follows.status(user, entity, entityId);
  }

  // SH-23
  @Patch('follows/:entity/:entityId/settings')
  @ApiOperation({ summary: 'Choose which updates and channels apply to one follow' })
  @ApiParam({ name: 'entity', enum: FollowableEntity })
  updateSettings(
    @CurrentUser() user: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(FollowableEntity)) entity: FollowableEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body() body: UpdateFollowSettingsDto,
  ) {
    return this.follows.updateSettings(user, entity, entityId, body);
  }

  // SH-24
  @Get('admin/follows/:entity/:entityId/count')
  @Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin: how many follow a record (no identities)' })
  @ApiParam({ name: 'entity', enum: FollowableEntity })
  count(
    @Param('entity', new ParseEnumPipe(FollowableEntity)) entity: FollowableEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.follows.count(entity, entityId);
  }
}

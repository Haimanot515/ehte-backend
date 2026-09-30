import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';

import { ExplorerService } from '../service/explorer.service';

// The permission depends on the entity in the URL, so it is checked inside ExplorerService instead of with @RequirePermissions
@ApiTags('Admin Explorer')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('admin/explorer')
export class ExplorerController {
  constructor(private readonly explorer: ExplorerService) {}

  @Get(':entity/:id')
  @ApiOperation({ summary: 'Get a record with its linked records and relation counts' })
  detail(
    @CurrentUser() user: CurrentUserDto,
    @Param('entity') entity: string,
    @Param('id') id: string,
  ) {
    return this.explorer.getDetail(user, entity, id);
  }

  @Get(':entity/:id/relations/:field')
  @ApiOperation({ summary: 'Get one paginated related list of a record' })
  related(
    @CurrentUser() user: CurrentUserDto,
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Param('field') field: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.explorer.getRelated(user, entity, id, field, page, limit);
  }
}
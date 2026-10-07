import { Body, Controller, Delete, Get, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { AdminNotesService } from '../service/admin-notes.service';
import { CreateNoteDto, NotesListQueryDto, NotesSearchQueryDto, UpdateNoteDto } from '../dto/admin-notes.dto';

/**
 * INTERNAL STAFF NOTES (SH-01 to SH-08) — private, the subject never sees them.
 *
 * ROUTE ORDER: 'mine' and 'search' are literals and come first. ':id/history' and
 * ':id/pin' are two-segment routes that would otherwise be swallowed by
 * ':entity/:entityId', so they are declared before it. ':id' (PATCH/DELETE) is last.
 * Reads of notes are audited (the note body is sensitive).
 */
@ApiTags('Admin: internal notes')
@ApiBearerAuth('access-token')
@Roles(RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN)
@Controller('admin/notes')
export class AdminNotesController {
  constructor(private readonly notes: AdminNotesService) {}

  // SH-07
  @Get('mine')
  @RequirePermissions(P.NOTE_READ)
  @AuditEvent({ action: AuditEventEnum.NOTE_READ, entity: 'Note' })
  @ApiOperation({ summary: 'Admin: notes I wrote across records' })
  mine(@CurrentUser() admin: CurrentUserDto, @Query() q: NotesListQueryDto) {
    return this.notes.listMine(admin, q);
  }

  // SH-08
  @Get('search')
  @RequirePermissions(P.NOTE_READ)
  @AuditEvent({ action: AuditEventEnum.NOTE_SEARCHED, entity: 'Note' })
  @ApiOperation({ summary: 'Admin: search notes' })
  search(@CurrentUser() admin: CurrentUserDto, @Query() q: NotesSearchQueryDto) {
    return this.notes.search(admin, q);
  }

  // SH-05
  @Get(':id/history')
  @RequirePermissions(P.NOTE_READ)
  @AuditEvent({ action: AuditEventEnum.NOTE_READ, entity: 'Note', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: edit history of one note' })
  history(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.history(admin, id);
  }

  // SH-06
  @Post(':id/pin')
  @RequirePermissions(P.NOTE_WRITE)
  @AuditEvent({ action: AuditEventEnum.NOTE_PINNED, entity: 'Note', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: pin a note to the top of its record (toggles)' })
  pin(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.togglePin(admin, id);
  }

  // SH-01
  @Get(':entity/:entityId')
  @RequirePermissions(P.NOTE_READ)
  @AuditEvent({ action: AuditEventEnum.NOTE_READ, entity: 'Note', entityId: { param: 'entityId' }, capture: ['params'] })
  @ApiOperation({ summary: 'Admin: staff notes on a record' })
  @ApiParam({ name: 'entity', enum: SharedRecordEntity })
  list(
    @CurrentUser() admin: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(SharedRecordEntity)) entity: SharedRecordEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query() q: NotesListQueryDto,
  ) {
    return this.notes.listForRecord(admin, entity, entityId, q);
  }

  // SH-02
  @Post(':entity/:entityId')
  @RequirePermissions(P.NOTE_WRITE)
  @AuditEvent({ action: AuditEventEnum.NOTE_CREATED, entity: 'Note', entityId: { param: 'entityId' }, capture: ['params'] })
  @ApiOperation({ summary: 'Admin: add a note to a record' })
  @ApiParam({ name: 'entity', enum: SharedRecordEntity })
  create(
    @CurrentUser() admin: CurrentUserDto,
    @Param('entity', new ParseEnumPipe(SharedRecordEntity)) entity: SharedRecordEntity,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body() body: CreateNoteDto,
  ) {
    return this.notes.create(admin, entity, entityId, body);
  }

  // SH-03
  @Patch(':id')
  @RequirePermissions(P.NOTE_WRITE)
  @AuditEvent({ action: AuditEventEnum.NOTE_EDITED, entity: 'Note', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: edit my own note (edit history kept)' })
  update(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateNoteDto) {
    return this.notes.update(admin, id, body);
  }

  // SH-04
  @Delete(':id')
  @RequirePermissions(P.NOTE_WRITE)
  @AuditEvent({ action: AuditEventEnum.NOTE_DELETED, entity: 'Note', entityId: { param: 'id' } })
  @ApiOperation({ summary: 'Admin: remove a note (soft delete)' })
  remove(@CurrentUser() admin: CurrentUserDto, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.softDelete(admin, id);
  }
}

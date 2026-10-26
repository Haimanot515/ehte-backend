import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StaffNote } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { pageMeta, paging } from '../../common/paging.util';
import { findSharedRecord, namesByUserId } from '../../common/shared-record.util';
import { CreateNoteDto, NotesListQueryDto, NotesSearchQueryDto, UpdateNoteDto } from '../dto/admin-notes.dto';

// A record can have at most this many pinned notes so the pinned block stays readable
const MAX_PINNED_PER_RECORD = 5;

const NOTE_ORDER: Prisma.StaffNoteOrderByWithRelationInput[] = [
  { pinned: 'desc' },
  { pinnedAt: 'desc' },
  { createdAt: 'desc' },
];

@Injectable()
export class AdminNotesService {
  constructor(private readonly prisma: PrismaService) {}

  // SH-01
  async listForRecord(
    _admin: CurrentUserDto,
    entity: SharedRecordEntity,
    entityId: string,
    q: NotesListQueryDto,
  ) {
    await this.assertRecord(entity, entityId);

    const { page, limit, skip } = paging(q);
    const where: Prisma.StaffNoteWhereInput = {
      entity,
      entityId,
      deletedAt: null,
      ...(q.pinnedOnly ? { pinned: true } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staffNote.findMany({ where, orderBy: NOTE_ORDER, skip, take: limit }),
      this.prisma.staffNote.count({ where }),
    ]);

    return { data: await this.shapeMany(rows), meta: pageMeta(page, limit, total) };
  }

  // SH-02
  async create(admin: CurrentUserDto, entity: SharedRecordEntity, entityId: string, body: CreateNoteDto) {
    await this.assertRecord(entity, entityId);

    const row = await this.prisma.staffNote.create({
      data: { entity, entityId, authorId: admin.id, body: body.body },
    });

    return (await this.shapeMany([row]))[0];
  }

  // SH-03
  async update(admin: CurrentUserDto, id: string, body: UpdateNoteDto) {
    const note = await this.getLive(id);
    if (note.authorId !== admin.id) {
      throw new ForbiddenException('You can only edit your own notes');
    }
    if (note.body === body.body) {
      return (await this.shapeMany([note]))[0];
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Guard on the old body so two edits at once cannot silently overwrite each other
      const res = await tx.staffNote.updateMany({
        where: { id, deletedAt: null, body: note.body },
        data: { body: body.body, editedAt: now },
      });
      if (res.count === 0) {
        throw new ConflictException('This note was changed by someone else. Reload and try again');
      }
      await tx.staffNoteRevision.create({
        data: { noteId: id, body: note.body, editedById: admin.id },
      });
      return tx.staffNote.findUniqueOrThrow({ where: { id } });
    });

    return (await this.shapeMany([updated]))[0];
  }

  // SH-04
  async softDelete(admin: CurrentUserDto, id: string) {
    const note = await this.getLive(id);
    const isSuper = admin.roles.includes(RolesEnum.SUPER_ADMIN);
    if (note.authorId !== admin.id && !isSuper) {
      throw new ForbiddenException('Only the author or a super admin can remove this note');
    }

    const res = await this.prisma.staffNote.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: admin.id, pinned: false, pinnedAt: null, pinnedById: null },
    });
    if (res.count === 0) throw new NotFoundException('Note not found');

    return { id, deleted: true };
  }

  // SH-05
  async history(_admin: CurrentUserDto, id: string) {
    const note = await this.getLive(id);

    const revisions = await this.prisma.staffNoteRevision.findMany({
      where: { noteId: id },
      orderBy: { createdAt: 'desc' },
    });

    const names = await namesByUserId(this.prisma, [note.authorId, ...revisions.map((r) => r.editedById)]);

    return {
      note: (await this.shapeMany([note]))[0],
      // Each revision holds the text as it was BEFORE that edit
      revisions: revisions.map((r) => ({
        id: r.id,
        body: r.body,
        editedById: r.editedById,
        editedByName: names.get(r.editedById) ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  // SH-06
  async togglePin(admin: CurrentUserDto, id: string) {
    const note = await this.getLive(id);

    if (!note.pinned) {
      const pinnedCount = await this.prisma.staffNote.count({
        where: { entity: note.entity, entityId: note.entityId, deletedAt: null, pinned: true },
      });
      if (pinnedCount >= MAX_PINNED_PER_RECORD) {
        throw new ConflictException(`A record can have at most ${MAX_PINNED_PER_RECORD} pinned notes`);
      }
    }

    const nextPinned = !note.pinned;
    const res = await this.prisma.staffNote.updateMany({
      where: { id, deletedAt: null, pinned: note.pinned },
      data: nextPinned
        ? { pinned: true, pinnedAt: new Date(), pinnedById: admin.id }
        : { pinned: false, pinnedAt: null, pinnedById: null },
    });
    if (res.count === 0) throw new ConflictException('This note was changed by someone else. Reload and try again');

    const fresh = await this.prisma.staffNote.findUniqueOrThrow({ where: { id } });
    return (await this.shapeMany([fresh]))[0];
  }

  // SH-07
  async listMine(admin: CurrentUserDto, q: NotesListQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.StaffNoteWhereInput = {
      authorId: admin.id,
      deletedAt: null,
      ...(q.pinnedOnly ? { pinned: true } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staffNote.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.staffNote.count({ where }),
    ]);

    return { data: await this.shapeMany(rows), meta: pageMeta(page, limit, total) };
  }

  // SH-08
  async search(_admin: CurrentUserDto, q: NotesSearchQueryDto) {
    const { page, limit, skip } = paging(q);

    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = new Date(q.from);
    if (q.to) createdAt.lte = new Date(q.to);
    if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
      throw new BadRequestException('"from" must be before "to"');
    }

    const where: Prisma.StaffNoteWhereInput = {
      deletedAt: null,
      body: { contains: q.q, mode: 'insensitive' },
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.authorId ? { authorId: q.authorId } : {}),
      ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staffNote.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.staffNote.count({ where }),
    ]);

    return { data: await this.shapeMany(rows), meta: pageMeta(page, limit, total) };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async assertRecord(entity: SharedRecordEntity, entityId: string) {
    const record = await findSharedRecord(this.prisma, entity, entityId);
    if (!record.exists) throw new NotFoundException('Record not found');
  }

  private async getLive(id: string): Promise<StaffNote> {
    const note = await this.prisma.staffNote.findFirst({ where: { id, deletedAt: null } });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }

  private async shapeMany(rows: StaffNote[]) {
    const names = await namesByUserId(this.prisma, rows.map((r) => r.authorId));
    return rows.map((r) => ({
      id: r.id,
      entity: r.entity,
      entityId: r.entityId,
      body: r.body,
      pinned: r.pinned,
      pinnedAt: r.pinnedAt,
      authorId: r.authorId,
      authorName: names.get(r.authorId) ?? null,
      edited: !!r.editedAt,
      editedAt: r.editedAt,
      createdAt: r.createdAt,
    }));
  }
}

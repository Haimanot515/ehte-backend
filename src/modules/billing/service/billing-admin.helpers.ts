// src/modules/billing/service/billing-admin.helpers.ts
//
// Small helpers shared by the new billing admin services.
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_EXPORT_ROWS = 10_000;

export function pageArgs(q: { page?: number; limit?: number }) {
  const page = q.page ?? 1;
  const limit = q.limit ?? 20;
  return { page, limit, skip: (page - 1) * limit };
}

export function pageResult<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// Turns optional from/to ISO dates into a concrete range. Dates without a time
// part mean the whole day, so `to` is moved to the end of that day.
export function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? endOfDayIfDateOnly(to) : new Date();
  const start = from
    ? new Date(from)
    : new Date(end.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('invalid_date_range');
  }
  if (start > end) throw new BadRequestException('from_must_be_before_to');
  return { from: start, to: end };
}

function endOfDayIfDateOnly(value: string): Date {
  const d = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) d.setUTCHours(23, 59, 59, 999);
  return d;
}

export function dec(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? 0);
}

// Decimal -> "123.45" so JSON never carries floating point.
export function money(value: Prisma.Decimal | number | string | null | undefined): string {
  return dec(value).toFixed(2);
}

export function parseMoney(raw: string): Prisma.Decimal {
  const d = new Prisma.Decimal(raw);
  if (!d.isFinite() || d.lte(0)) throw new BadRequestException('amount_must_be_positive');
  return d;
}

// Shows the last four characters only.
export function maskTail(value: string | null | undefined): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `${'*'.repeat(Math.max(value.length - 4, 0))}${tail}`;
}

// Super admins see names. Other admins see a short mask.
export function maskName(name: string | null | undefined, isSuperAdmin: boolean): string | null {
  if (!name) return null;
  if (isSuperAdmin) return name;
  const first = name.trim().charAt(0).toUpperCase();
  return `${first}***`;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Guards against spreadsheet formula injection from free text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

// Postgres date_trunc unit for a granularity.
export function truncUnit(granularity: 'day' | 'week' | 'month' | undefined): 'day' | 'week' | 'month' {
  return granularity ?? 'day';
}

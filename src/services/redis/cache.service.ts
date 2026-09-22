// src/services/redis/cache.service.ts

import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from './redis.service';
import { CacheKeys, TTL } from './cache.keys';

const CACHE_ENABLED_KEY = 'ehte:cache:enabled';
const FLAG_MEMO_MS = 5000;

// Deep-sorted, JSON-stable so equivalent queries always hash the same.
function stableStringify(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => normalize(x) ?? null);
    if (typeof v === 'object') {
      return Object.keys(v as object)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          const n = normalize((v as Record<string, unknown>)[k]);
          if (n !== undefined) acc[k] = n;
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(normalize(value)) ?? '';
}

@Injectable()
export class CacheService {
  private flagMemo = { value: true, checkedAt: 0 };

  constructor(private readonly redis: RedisService) {}

  async enableCache(): Promise<void> {
    await this.redis.del(CACHE_ENABLED_KEY);
    this.flagMemo = { value: true, checkedAt: Date.now() };
  }

  async disableCache(): Promise<void> {
    await this.redis.set(CACHE_ENABLED_KEY, false);
    this.flagMemo = { value: false, checkedAt: Date.now() };
  }

  async isCacheEnabled(): Promise<boolean> {
    const now = Date.now();
    if (now - this.flagMemo.checkedAt < FLAG_MEMO_MS) {
      return this.flagMemo.value;
    }
    const raw = await this.redis.get<boolean>(CACHE_ENABLED_KEY);
    this.flagMemo = { value: raw !== false, checkedAt: now };
    return this.flagMemo.value;
  }

  private async canUseCache(): Promise<boolean> {
    return this.redis.isConnected && (await this.isCacheEnabled());
  }

  private async read<T>(key: string): Promise<T | null> {
    if (!(await this.canUseCache())) return null;
    return this.redis.get<T>(key);
  }

  private async write(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (!(await this.canUseCache())) return;
    await this.redis.set(key, value, ttlSeconds);
  }

  private async readRaw(key: string): Promise<string | null> {
    if (!(await this.canUseCache())) return null;
    return this.redis.getRaw(key);
  }

  private async writeRaw(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    if (!(await this.canUseCache())) return;
    await this.redis.setRaw(key, value, ttlSeconds);
  }

  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached !== null) return cached;
    const value = await factory();
    if (value !== null && value !== undefined) {
      await this.write(key, value, ttlSeconds);
    }
    return value;
  }

  private hashQuery(query: Record<string, unknown>): string {
    return createHash('sha256')
      .update(stableStringify(query))
      .digest('hex')
      .slice(0, 32);
  }

  private hashIdentifier(identifier: string): string {
    return createHash('sha256')
      .update(identifier.trim().toLowerCase())
      .digest('hex');
  }

  getSession<T>(userId: string) {
    return this.read<T>(CacheKeys.session(userId));
  }

  setSession(userId: string, data: unknown) {
    return this.write(CacheKeys.session(userId), data, TTL.SESSION);
  }

  clearSession(userId: string) {
    return this.redis.del(CacheKeys.session(userId));
  }

  incrementFailedLoginAttempts(identifier: string): Promise<number | null> {
    return this.redis.incrementWithTtl(
      CacheKeys.failedLoginAttempts(this.hashIdentifier(identifier)),
      TTL.FAILED_LOGIN_ATTEMPTS,
    );
  }

  // Returns null (not 0) when Redis is down, so callers must check Postgres instead.
  async getFailedLoginAttempts(identifier: string): Promise<number | null> {
    if (!this.redis.isConnected) return null;
    const raw = await this.redis.getRaw(
      CacheKeys.failedLoginAttempts(this.hashIdentifier(identifier)),
    );
    return raw ? parseInt(raw, 10) : 0;
  }

  resetFailedLoginAttempts(identifier: string) {
    return this.redis.del(
      CacheKeys.failedLoginAttempts(this.hashIdentifier(identifier)),
    );
  }

  purgeUserCache(userId: string) {
    return this.redis.delByPattern(CacheKeys.patterns.userAll(userId));
  }

  getReportStatus<T>(reportId: string) {
    return this.read<T>(CacheKeys.reportStatus(reportId));
  }

  setReportStatus(reportId: string, data: unknown) {
    return this.write(
      CacheKeys.reportStatus(reportId),
      data,
      TTL.REPORT_STATUS,
    );
  }

  invalidateReportStatus(reportId: string) {
    return this.redis.del(CacheKeys.reportStatus(reportId));
  }

  getMyReports<T>(userId: string, page = 1) {
    return this.read<T>(CacheKeys.myReports(userId, page));
  }

  setMyReports(userId: string, data: unknown, page = 1) {
    return this.write(
      CacheKeys.myReports(userId, page),
      data,
      TTL.MY_REPORTS,
    );
  }

  invalidateMyReports(userId: string) {
    return this.redis.delByPattern(CacheKeys.patterns.userReports(userId));
  }

  getPost<T>(postId: string) {
    return this.read<T>(CacheKeys.post(postId));
  }

  setPost(postId: string, data: unknown) {
    return this.write(CacheKeys.post(postId), data, TTL.POST_DETAIL);
  }

  invalidatePost(postId: string) {
    return this.redis.del(CacheKeys.post(postId));
  }

  wrapPostList<T>(
    query: Record<string, unknown>,
    factory: () => Promise<T>,
  ): Promise<T> {
    return this.wrap(
      CacheKeys.postList(this.hashQuery(query)),
      factory,
      TTL.POST_LIST,
    );
  }

  invalidatePostLists() {
    return this.redis.delByPattern(CacheKeys.patterns.postLists());
  }

  // Call on approve, reject, edit, unpublish or takedown.
  async invalidatePostEverywhere(postId: string): Promise<void> {
    await Promise.all([
      this.invalidatePost(postId),
      this.invalidatePostLists(),
    ]);
  }

  getMyPosts<T>(userId: string, page = 1) {
    return this.read<T>(CacheKeys.myPosts(userId, page));
  }

  setMyPosts(userId: string, data: unknown, page = 1) {
    return this.write(CacheKeys.myPosts(userId, page), data, TTL.MY_POSTS);
  }

  invalidateMyPosts(userId: string) {
    return this.redis.delByPattern(CacheKeys.patterns.userPosts(userId));
  }

  async getPendingPostsCount(): Promise<number | null> {
    const raw = await this.readRaw(CacheKeys.pendingPostsCount());
    return raw === null ? null : parseInt(raw, 10);
  }

  setPendingPostsCount(count: number) {
    return this.writeRaw(
      CacheKeys.pendingPostsCount(),
      String(count),
      TTL.PENDING_POSTS_COUNT,
    );
  }

  invalidatePendingPostsCount() {
    return this.redis.del(CacheKeys.pendingPostsCount());
  }

  getMissingPerson<T>(id: string) {
    return this.read<T>(CacheKeys.missingPerson(id));
  }

  setMissingPerson(id: string, data: unknown) {
    return this.write(
      CacheKeys.missingPerson(id),
      data,
      TTL.MISSING_PERSON_DETAIL,
    );
  }

  invalidateMissingPerson(id: string) {
    return this.redis.del(CacheKeys.missingPerson(id));
  }

  wrapMissingPersonList<T>(
    query: Record<string, unknown>,
    factory: () => Promise<T>,
  ): Promise<T> {
    return this.wrap(
      CacheKeys.missingPersonList(this.hashQuery(query)),
      factory,
      TTL.MISSING_PERSON_LIST,
    );
  }

  getApprovedMissingPersons<T>(page = 1) {
    return this.read<T>(CacheKeys.approvedMissingPersons(page));
  }

  setApprovedMissingPersons(data: unknown, page = 1) {
    return this.write(
      CacheKeys.approvedMissingPersons(page),
      data,
      TTL.APPROVED_MISSING_PERSONS,
    );
  }

  invalidateMissingPersonCaches() {
    return Promise.all([
      this.redis.delByPattern(CacheKeys.patterns.missingPersonLists()),
      this.redis.delByPattern(CacheKeys.patterns.approvedMissingPersons()),
    ]);
  }

  // Call on approve, reject, edit, unpublish or takedown.
  async invalidateMissingPersonEverywhere(id: string): Promise<void> {
    await Promise.all([
      this.invalidateMissingPerson(id),
      this.invalidateMissingPersonCaches(),
    ]);
  }

  // ───────────────────────────────────────────
  // INFORMATION SUBMISSION
  // Lists are scoped per missing-person case, not global — invalidation
  // only clears that case's cached lists, not every submission list.
  // ───────────────────────────────────────────

  wrapInformationSubmissionList<T>(
    missingPersonId: string,
    query: Record<string, unknown>,
    factory: () => Promise<T>,
  ): Promise<T> {
    return this.wrap(
      CacheKeys.informationSubmissionList(missingPersonId, this.hashQuery(query)),
      factory,
      TTL.INFORMATION_SUBMISSION_LIST,
    );
  }

  invalidateInformationSubmissionList(missingPersonId: string) {
    return this.redis.delByPattern(
      CacheKeys.patterns.informationSubmissionLists(missingPersonId),
    );
  }

  getVictimProfile<T>(id: string) {
    return this.read<T>(CacheKeys.victimProfile(id));
  }

  setVictimProfile(id: string, data: unknown) {
    return this.write(
      CacheKeys.victimProfile(id),
      data,
      TTL.VICTIM_PROFILE_DETAIL,
    );
  }

  invalidateVictimProfile(id: string) {
    return this.redis.del(CacheKeys.victimProfile(id));
  }

  wrapVictimProfileList<T>(
    query: Record<string, unknown>,
    factory: () => Promise<T>,
  ): Promise<T> {
    return this.wrap(
      CacheKeys.victimProfileList(this.hashQuery(query)),
      factory,
      TTL.VICTIM_PROFILE_LIST,
    );
  }

  getApprovedVictimProfiles<T>(page = 1) {
    return this.read<T>(CacheKeys.approvedVictimProfiles(page));
  }

  setApprovedVictimProfiles(data: unknown, page = 1) {
    return this.write(
      CacheKeys.approvedVictimProfiles(page),
      data,
      TTL.APPROVED_VICTIM_PROFILES,
    );
  }

  invalidateApprovedVictimProfiles() {
    return Promise.all([
      this.redis.delByPattern(CacheKeys.patterns.victimProfileLists()),
      this.redis.delByPattern(CacheKeys.patterns.approvedVictimProfiles()),
    ]);
  }

  // Call on approve, reject, edit, unpublish or takedown.
  async invalidateVictimProfileEverywhere(id: string): Promise<void> {
    await Promise.all([
      this.invalidateVictimProfile(id),
      this.invalidateApprovedVictimProfiles(),
    ]);
  }

  getNotifications<T>(userId: string, page = 1) {
    return this.read<T>(CacheKeys.notifications(userId, page));
  }

  setNotifications(userId: string, data: unknown, page = 1) {
    return this.write(
      CacheKeys.notifications(userId, page),
      data,
      TTL.NOTIFICATIONS,
    );
  }

  invalidateNotifications(userId: string) {
    return this.redis.delByPattern(
      CacheKeys.patterns.userNotifications(userId),
    );
  }

  async getUnreadNotificationCount(userId: string): Promise<number | null> {
    const raw = await this.readRaw(CacheKeys.unreadNotificationCount(userId));
    return raw === null ? null : parseInt(raw, 10);
  }

  setUnreadNotificationCount(userId: string, count: number) {
    return this.writeRaw(
      CacheKeys.unreadNotificationCount(userId),
      String(count),
      TTL.UNREAD_NOTIFICATION_COUNT,
    );
  }

  invalidateUnreadNotificationCount(userId: string) {
    return this.redis.del(CacheKeys.unreadNotificationCount(userId));
  }

  getIncidentCategories<T>() {
    return this.read<T>(CacheKeys.incidentCategories());
  }

  setIncidentCategories(data: unknown) {
    return this.write(CacheKeys.incidentCategories(), data, TTL.TAXONOMY);
  }

  invalidateIncidentCategories() {
    return this.redis.del(CacheKeys.incidentCategories());
  }

  getSupportCategories<T>() {
    return this.read<T>(CacheKeys.supportCategories());
  }

  setSupportCategories(data: unknown) {
    return this.write(CacheKeys.supportCategories(), data, TTL.TAXONOMY);
  }

  invalidateSupportCategories() {
    return this.redis.del(CacheKeys.supportCategories());
  }

  wrapAdminDashboardStats<T>(factory: () => Promise<T>): Promise<T> {
    return this.wrap(
      CacheKeys.adminDashboardStats(),
      factory,
      TTL.ADMIN_DASHBOARD_STATS,
    );
  }

  invalidateAdminDashboardStats() {
    return this.redis.del(CacheKeys.adminDashboardStats());
  }
}
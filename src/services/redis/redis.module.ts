// src/services/redis/redis.module.ts

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

// Global: import once in AppModule, inject anywhere.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService, CacheService, RedisThrottlerStorage],
  exports: [RedisService, CacheService, RedisThrottlerStorage],
})
export class RedisModule {}

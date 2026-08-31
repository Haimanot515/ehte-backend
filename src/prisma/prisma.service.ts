import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { AsyncLocalStorage } from 'async_hooks';

const txStorage = new AsyncLocalStorage<Prisma.TransactionClient>();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly configService: ConfigService) {
    super({
      adapter: new PrismaPg(configService.getOrThrow<string>('database.url')),
    });

    // Automatically route Prisma model operations
    // through the active transaction client.
    return new Proxy(this, {
      get(target, prop: string | symbol) {
        const tx = txStorage.getStore();

        if (tx && typeof prop === 'string' && prop in tx) {
          const value = (tx as any)[prop];

          return typeof value === 'function' ? value.bind(tx) : value;
        }

        const value = (target as any)[prop];

        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  // Run Ehte database operations inside
  // a Prisma transaction.
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.$transaction((tx) => txStorage.run(tx, fn));
  }

  // Run an operation outside the current
  // transaction using the normal Prisma client.
  runFresh<T>(fn: () => Promise<T>): Promise<T> {
    return txStorage.exit(fn);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();

    this.logger.log('Ehte Prisma database connection established');
  }
}

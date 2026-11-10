import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      super({
        datasources: {
          db: {
            url: dbUrl,
          },
        },
      });
    } else {
      super();
    }
  }

  async onModuleInit(): Promise<void> {
    // When DATABASE_URL is configured, attempt connection on module initialization.
    // In unit test contexts where DATABASE_URL is not set or DB is unavailable,
    // connection failure does not prevent NestJS context creation for non-DB providers.
    if (process.env.DATABASE_URL) {
      try {
        await this.$connect();
      } catch {
        // Ignored during module init; database tests perform explicit readiness check.
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
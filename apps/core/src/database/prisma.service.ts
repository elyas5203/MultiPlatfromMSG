import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const DEFAULT_DEV_DATABASE_URL =
  'postgresql://postgres@127.0.0.1:54332/postgres?schema=public';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const dbUrl = process.env.DATABASE_URL || DEFAULT_DEV_DATABASE_URL;
    super({
      datasources: {
        db: {
          url: dbUrl,
        },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect lazily or attempt connection if server is already up.
    // If server is starting up or in unit tests, PrismaClient connects on first database query.
    try {
      await this.$connect();
    } catch {
      // Ignored during module init; first query or explicit test ping will connect.
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { InMemoryTenantScopeRepository } from './tenant/tenant-scope';
import { TenantRepository } from './tenant/tenant.repository';
import { AuthModule } from './auth/auth.module';
import { ContactsModule } from './contacts/contacts.module';
import { TenantMiddleware } from './tenant/tenant.middleware';

@Module({
  imports: [DatabaseModule, AuthModule, ContactsModule],
  controllers: [],
  providers: [InMemoryTenantScopeRepository, TenantRepository],
  exports: [
    InMemoryTenantScopeRepository,
    TenantRepository,
    DatabaseModule,
    AuthModule,
    ContactsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}

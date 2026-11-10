import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { InMemoryTenantScopeRepository } from './tenant/tenant-scope';
import { TenantRepository } from './tenant/tenant.repository';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [],
  providers: [InMemoryTenantScopeRepository, TenantRepository],
  exports: [InMemoryTenantScopeRepository, TenantRepository, DatabaseModule, AuthModule],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { InMemoryTenantScopeRepository } from './tenant/tenant-scope';
import { TenantRepository } from './tenant/tenant.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [],
  providers: [InMemoryTenantScopeRepository, TenantRepository],
  exports: [InMemoryTenantScopeRepository, TenantRepository, DatabaseModule],
})
export class AppModule {}

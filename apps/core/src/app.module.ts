import { Module } from '@nestjs/common';
import { InMemoryTenantScopeRepository } from './tenant/tenant-scope';

@Module({
  imports: [],
  controllers: [],
  providers: [InMemoryTenantScopeRepository],
  exports: [InMemoryTenantScopeRepository],
})
export class AppModule {}

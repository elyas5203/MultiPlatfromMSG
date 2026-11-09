import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  InMemoryTenantScopeRepository,
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

describe('Tenant Scope In-Memory Repository & Boundary Verification', () => {
  let repository: InMemoryTenantScopeRepository;

  // Synthetic test tenant IDs
  const TENANT_ALPHA = 'org_synthetic_alpha_101';
  const TENANT_BETA = 'org_synthetic_beta_202';

  beforeEach(() => {
    repository = new InMemoryTenantScopeRepository();
  });

  describe('Synthetic Two-Tenant Isolation (AC-02)', () => {
    it('should save records under respective tenants and retrieve them correctly', () => {
      const alphaRecord = repository.save(TENANT_ALPHA, 'rec-alpha-1', {
        sampleName: 'Alpha Synthetic Contact',
        sampleChannel: 'mock_channel_alpha',
      });

      const betaRecord = repository.save(TENANT_BETA, 'rec-beta-1', {
        sampleName: 'Beta Synthetic Contact',
        sampleChannel: 'mock_channel_beta',
      });

      assert.strictEqual(alphaRecord.tenantId, TENANT_ALPHA);
      assert.strictEqual(alphaRecord.id, 'rec-alpha-1');
      assert.strictEqual(betaRecord.tenantId, TENANT_BETA);
      assert.strictEqual(betaRecord.id, 'rec-beta-1');

      const retrievedAlpha = repository.findById(TENANT_ALPHA, 'rec-alpha-1');
      assert.ok(retrievedAlpha);
      assert.strictEqual(retrievedAlpha?.tenantId, TENANT_ALPHA);
      assert.strictEqual(retrievedAlpha?.payload.sampleName, 'Alpha Synthetic Contact');

      const retrievedBeta = repository.findById(TENANT_BETA, 'rec-beta-1');
      assert.ok(retrievedBeta);
      assert.strictEqual(retrievedBeta?.tenantId, TENANT_BETA);
      assert.strictEqual(retrievedBeta?.payload.sampleName, 'Beta Synthetic Contact');
    });

    it('must NEVER return a record belonging to another tenant (cross-tenant leak prevention)', () => {
      repository.save(TENANT_ALPHA, 'secret-doc-alpha', {
        confidentialPayload: 'Alpha internal synthetic data',
      });

      // Tenant Beta attempts to query Tenant Alpha's record
      const crossTenantQuery = repository.findById(TENANT_BETA, 'secret-doc-alpha');
      assert.strictEqual(
        crossTenantQuery,
        null,
        'Tenant Beta must not be able to read Tenant Alpha record',
      );

      // Even if Tenant Beta creates a record with identical ID, payloads remain completely isolated
      repository.save(TENANT_BETA, 'secret-doc-alpha', {
        confidentialPayload: 'Beta internal synthetic data',
      });

      const alphaRead = repository.findById(TENANT_ALPHA, 'secret-doc-alpha');
      const betaRead = repository.findById(TENANT_BETA, 'secret-doc-alpha');

      assert.strictEqual(alphaRead?.payload.confidentialPayload, 'Alpha internal synthetic data');
      assert.strictEqual(betaRead?.payload.confidentialPayload, 'Beta internal synthetic data');
    });

    it('must isolate collection queries between tenants', () => {
      repository.save(TENANT_ALPHA, 'doc-1', { tag: 'A1' });
      repository.save(TENANT_ALPHA, 'doc-2', { tag: 'A2' });
      repository.save(TENANT_BETA, 'doc-3', { tag: 'B1' });

      const alphaList = repository.findAll(TENANT_ALPHA);
      const betaList = repository.findAll(TENANT_BETA);

      assert.strictEqual(alphaList.length, 2);
      assert.ok(alphaList.every((item) => item.tenantId === TENANT_ALPHA));

      assert.strictEqual(betaList.length, 1);
      assert.ok(betaList.every((item) => item.tenantId === TENANT_BETA));

      assert.strictEqual(repository.countByTenant(TENANT_ALPHA), 2);
      assert.strictEqual(repository.countByTenant(TENANT_BETA), 1);
    });
  });

  describe('Missing tenant_id Rejection (AC-02)', () => {
    it('must reject findById operations when tenant_id is missing or empty', () => {
      assert.throws(
        () => repository.findById(null, 'rec-1'),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.findById(undefined, 'rec-1'),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.findById('', 'rec-1'),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.findById('   ', 'rec-1'),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
    });

    it('must reject save operations when tenant_id is missing or empty', () => {
      assert.throws(
        () => repository.save(null, 'rec-1', { dummy: 1 }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.save(undefined, 'rec-1', { dummy: 1 }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.save('', 'rec-1', { dummy: 1 }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
    });

    it('must reject collection queries when tenant_id is missing or empty', () => {
      assert.throws(
        () => repository.findAll(null),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => repository.countByTenant(undefined),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
    });
  });

  describe('Invalid tenant_id Rejection (AC-02)', () => {
    it('must reject non-string tenant_id values', () => {
      assert.throws(
        () => repository.findById(12345 as unknown as string, 'rec-1'),
        (err: unknown) => err instanceof TenantScopeInvalidError,
      );

      assert.throws(
        () => repository.findById({ id: 'org' } as unknown as string, 'rec-1'),
        (err: unknown) => err instanceof TenantScopeInvalidError,
      );
    });

    it('must reject malformed or illegal characters in tenant_id', () => {
      const illegalTenantIds = [
        '../path_traversal',
        'tenant with spaces',
        'tenant$invalid#',
        'tenant/slash',
        'a'.repeat(65), // Exceeds max length limit
      ];

      for (const illegalId of illegalTenantIds) {
        assert.throws(
          () => repository.findById(illegalId, 'rec-1'),
          (err: unknown) => err instanceof TenantScopeInvalidError,
          `Expected rejection for illegal tenantId: ${illegalId}`,
        );
      }
    });
  });

  describe('NestJS Application Context & DI Integration', () => {
    it('should successfully initialize AppModule and resolve InMemoryTenantScopeRepository', async () => {
      const appContext = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
      });

      const repoFromDi = appContext.get(InMemoryTenantScopeRepository);
      assert.ok(repoFromDi, 'InMemoryTenantScopeRepository should be resolvable from NestJS context');

      repoFromDi.save(TENANT_ALPHA, 'di-rec-1', { source: 'nestjs-di' });
      const record = repoFromDi.findById(TENANT_ALPHA, 'di-rec-1');
      assert.strictEqual(record?.payload.source, 'nestjs-di');

      await appContext.close();
    });
  });
});

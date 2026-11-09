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

    it('must prevent shared mutable references and cross-tenant mutation leak via deep copy (Regression Test)', () => {
      // Shared synthetic nested payload object
      const nestedSharedPayload = {
        meta: {
          tag: 'original-nested-tag',
          details: { nestedCounter: 100 },
        },
      };

      // Both tenants save records that originally reference identical payload structure
      repository.save(TENANT_ALPHA, 'doc-shared-nested', nestedSharedPayload);
      repository.save(TENANT_BETA, 'doc-shared-nested', nestedSharedPayload);

      // Mutate the original input object after save
      (nestedSharedPayload.meta.details as { nestedCounter: number }).nestedCounter = 999;
      (nestedSharedPayload.meta as { tag: string }).tag = 'corrupted-input';

      // Read back Tenant Alpha's record
      const readAlpha = repository.findById(TENANT_ALPHA, 'doc-shared-nested');
      assert.ok(readAlpha);
      assert.strictEqual(
        (readAlpha?.payload.meta as { tag: string }).tag,
        'original-nested-tag',
        'Saved record must not be affected by mutation of original input object',
      );

      // Mutate the returned payload object from Tenant Alpha's read
      (readAlpha?.payload.meta as { tag: string }).tag = 'mutated-by-alpha-consumer';
      ((readAlpha?.payload.meta as Record<string, unknown>).details as { nestedCounter: number }).nestedCounter = 888;

      // Read back Tenant Beta's record and verify complete absence of reference leak
      const readBeta = repository.findById(TENANT_BETA, 'doc-shared-nested');
      assert.ok(readBeta);
      assert.strictEqual(
        (readBeta?.payload.meta as { tag: string }).tag,
        'original-nested-tag',
        'Tenant Beta record must not reflect mutation performed on Tenant Alpha returned payload',
      );
      assert.strictEqual(
        ((readBeta?.payload.meta as Record<string, unknown>).details as { nestedCounter: number }).nestedCounter,
        100,
        'Tenant Beta nested details counter must remain unaffected',
      );

      // Second read of Tenant Alpha must also be untainted by prior consumer mutation
      const secondReadAlpha = repository.findById(TENANT_ALPHA, 'doc-shared-nested');
      assert.strictEqual(
        (secondReadAlpha?.payload.meta as { tag: string }).tag,
        'original-nested-tag',
        'Internal repository storage must remain untainted by external consumer mutations',
      );
    });

    it('must strictly enforce tenant boundary during clearTenant operations', () => {
      repository.save(TENANT_ALPHA, 'doc-a1', { label: 'A1' });
      repository.save(TENANT_ALPHA, 'doc-a2', { label: 'A2' });
      repository.save(TENANT_BETA, 'doc-b1', { label: 'B1' });

      // Clear only Tenant Alpha records
      repository.clearTenant(TENANT_ALPHA);

      assert.strictEqual(repository.countByTenant(TENANT_ALPHA), 0);
      assert.strictEqual(repository.findById(TENANT_ALPHA, 'doc-a1'), null);

      // Tenant Beta must be completely intact
      assert.strictEqual(repository.countByTenant(TENANT_BETA), 1);
      assert.strictEqual(repository.findById(TENANT_BETA, 'doc-b1')?.payload.label, 'B1');

      // clearTenant without valid tenantId must throw
      assert.throws(
        () => repository.clearTenant(null),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
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

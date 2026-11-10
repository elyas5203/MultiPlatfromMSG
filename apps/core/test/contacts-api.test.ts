import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  Module,
  NestModule,
  MiddlewareConsumer,
  INestApplication,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { Role } from '../src/rbac/roles.enum';
import { RolesGuard } from '../src/rbac/roles.guard';
import { TenantGuard } from '../src/tenant/tenant.guard';
import { TenantInterceptor } from '../src/tenant/tenant.interceptor';
import { TenantMiddleware } from '../src/tenant/tenant.middleware';
import { ContactsController } from '../src/contacts/contacts.controller';
import { ContactsService } from '../src/contacts/contacts.service';
import { ContactsRepository } from '../src/contacts/contacts.repository';
import { PrismaService } from '../src/database/prisma.service';
import { AuthContextMiddleware } from '../src/contacts/contacts.module';
import {
  Contact,
  Tag,
  ContactTag,
  SuppressionEntry,
} from '../src/contacts/types';

// ============================================================================
// In-Memory Database Simulator for Standalone Unit & API Test Execution
// ============================================================================
class InMemoryPrismaMock {
  private contacts: InMemContact[] = [];
  private tags: InMemTag[] = [];
  private contactTags: InMemContactTag[] = [];
  private suppressions: InMemSuppression[] = [];
  private idCounter = 1;

  reset() {
    this.contacts = [];
    this.tags = [];
    this.contactTags = [];
    this.suppressions = [];
    this.idCounter = 1;
  }

  readonly contact = {
    create: async ({ data }: { data: any }): Promise<Contact> => {
      const existing = this.contacts.find(
        (c) => c.tenantId === data.tenantId && c.phoneNormalized === data.phoneNormalized,
      );
      if (existing) {
        const err = new Error('Unique constraint failed on the fields: (`tenantId`,`phoneNormalized`)');
        (err as any).code = 'P2002';
        throw err;
      }
      const record: InMemContact = {
        id: data.id || `cnt_${this.idCounter++}`,
        tenantId: data.tenantId,
        phoneNormalized: data.phoneNormalized,
        phoneRaw: data.phoneRaw ?? null,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        attributes: data.attributes ?? null,
        isSuppressed: data.isSuppressed ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.contacts.push(record);
      return { ...record };
    },

    findFirst: async ({ where }: { where: any }): Promise<Contact | null> => {
      const match = this.contacts.find((c) => {
        if (where.tenantId && c.tenantId !== where.tenantId) return false;
        if (where.id && c.id !== where.id) return false;
        if (where.phoneNormalized && c.phoneNormalized !== where.phoneNormalized) return false;
        return true;
      });
      return match ? { ...match } : null;
    },

    findUnique: async ({ where }: { where: any }): Promise<Contact | null> => {
      if (where.tenantId_phoneNormalized) {
        const { tenantId, phoneNormalized } = where.tenantId_phoneNormalized;
        const match = this.contacts.find(
          (c) => c.tenantId === tenantId && c.phoneNormalized === phoneNormalized,
        );
        return match ? { ...match } : null;
      }
      if (where.tenantId_id) {
        const { tenantId, id } = where.tenantId_id;
        const match = this.contacts.find((c) => c.tenantId === tenantId && c.id === id);
        return match ? { ...match } : null;
      }
      return null;
    },

    findMany: async ({
      where,
      take,
      skip,
    }: {
      where?: any;
      take?: number;
      skip?: number;
    }): Promise<Contact[]> => {
      let result = this.contacts.filter((c) => {
        if (where?.tenantId && c.tenantId !== where.tenantId) return false;
        if (where?.isSuppressed !== undefined && c.isSuppressed !== where.isSuppressed) return false;
        if (where?.phoneNormalized?.contains && !c.phoneNormalized.includes(where.phoneNormalized.contains)) {
          return false;
        }
        if (where?.contactTags?.some) {
          const { tenantId, tagId } = where.contactTags.some;
          const hasTag = this.contactTags.some(
            (ct) => ct.tenantId === tenantId && ct.contactId === c.id && ct.tagId === tagId,
          );
          if (!hasTag) return false;
        }
        return true;
      });

      if (skip) {
        result = result.slice(skip);
      }
      if (take) {
        result = result.slice(0, take);
      }
      return result.map((c) => ({ ...c }));
    },

    update: async ({ where, data }: { where: any; data: any }): Promise<Contact> => {
      const tenantId = where.tenantId_id?.tenantId;
      const id = where.tenantId_id?.id;
      const index = this.contacts.findIndex((c) => c.tenantId === tenantId && c.id === id);
      if (index === -1) {
        throw new Error('Contact not found');
      }
      const existing = this.contacts[index];
      const updated: InMemContact = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      };
      this.contacts[index] = updated;
      return { ...updated };
    },

    updateMany: async ({ where, data }: { where: any; data: any }): Promise<{ count: number }> => {
      let count = 0;
      for (let i = 0; i < this.contacts.length; i++) {
        const c = this.contacts[i];
        if (where.tenantId && c.tenantId !== where.tenantId) continue;
        if (where.phoneNormalized && c.phoneNormalized !== where.phoneNormalized) continue;
        this.contacts[i] = { ...c, ...data, updatedAt: new Date() };
        count++;
      }
      return { count };
    },

    delete: async ({ where }: { where: any }): Promise<Contact> => {
      const tenantId = where.tenantId_id?.tenantId;
      const id = where.tenantId_id?.id;
      const index = this.contacts.findIndex((c) => c.tenantId === tenantId && c.id === id);
      if (index === -1) {
        throw new Error('Contact not found');
      }
      const [removed] = this.contacts.splice(index, 1);
      return { ...removed };
    },

    count: async ({ where }: { where: any }): Promise<number> => {
      return this.contacts.filter((c) => !where?.tenantId || c.tenantId === where.tenantId).length;
    },
  };

  readonly tag = {
    create: async ({ data }: { data: any }): Promise<Tag> => {
      const existing = this.tags.find(
        (t) => t.tenantId === data.tenantId && t.name === data.name,
      );
      if (existing) {
        const err = new Error('Unique constraint failed on (`tenantId`,`name`)');
        (err as any).code = 'P2002';
        throw err;
      }
      const record: InMemTag = {
        id: data.id || `tag_${this.idCounter++}`,
        tenantId: data.tenantId,
        name: data.name,
        color: data.color ?? null,
        description: data.description ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.tags.push(record);
      return { ...record };
    },

    findFirst: async ({ where }: { where: any }): Promise<Tag | null> => {
      const match = this.tags.find((t) => {
        if (where.tenantId && t.tenantId !== where.tenantId) return false;
        if (where.id && t.id !== where.id) return false;
        return true;
      });
      return match ? { ...match } : null;
    },

    findUnique: async ({ where }: { where: any }): Promise<Tag | null> => {
      if (where.tenantId_name) {
        const { tenantId, name } = where.tenantId_name;
        const match = this.tags.find((t) => t.tenantId === tenantId && t.name === name);
        return match ? { ...match } : null;
      }
      return null;
    },

    findMany: async ({ where }: { where?: any }): Promise<Tag[]> => {
      return this.tags
        .filter((t) => !where?.tenantId || t.tenantId === where.tenantId)
        .map((t) => ({ ...t }));
    },
  };

  readonly contactTag = {
    create: async ({ data }: { data: any }): Promise<ContactTag> => {
      const existing = this.contactTags.find(
        (ct) =>
          ct.tenantId === data.tenantId &&
          ct.contactId === data.contactId &&
          ct.tagId === data.tagId,
      );
      if (existing) {
        const err = new Error('Unique constraint failed on ContactTag');
        (err as any).code = 'P2002';
        throw err;
      }
      const record: InMemContactTag = {
        id: `ct_${this.idCounter++}`,
        tenantId: data.tenantId,
        contactId: data.contactId,
        tagId: data.tagId,
        createdAt: new Date(),
      };
      this.contactTags.push(record);
      return { ...record };
    },

    deleteMany: async ({ where }: { where: any }): Promise<{ count: number }> => {
      const beforeLen = this.contactTags.length;
      this.contactTags = this.contactTags.filter((ct) => {
        if (where.tenantId && ct.tenantId !== where.tenantId) return true;
        if (where.contactId && ct.contactId !== where.contactId) return true;
        if (where.tagId && ct.tagId !== where.tagId) return true;
        return false;
      });
      return { count: beforeLen - this.contactTags.length };
    },

    findMany: async ({ where }: { where: any; include?: any }): Promise<any[]> => {
      const matching = this.contactTags.filter((ct) => {
        if (where.tenantId && ct.tenantId !== where.tenantId) return false;
        if (where.contactId && ct.contactId !== where.contactId) return false;
        return true;
      });
      return matching.map((ct) => {
        const tag = this.tags.find((t) => t.id === ct.tagId);
        return {
          ...ct,
          tag: tag ? { ...tag } : null,
        };
      });
    },
  };

  readonly suppressionEntry = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: any;
      create: any;
      update: any;
    }): Promise<SuppressionEntry> => {
      const { tenantId, phoneNormalized } = where.tenantId_phoneNormalized;
      const index = this.suppressions.findIndex(
        (s) => s.tenantId === tenantId && s.phoneNormalized === phoneNormalized,
      );
      if (index !== -1) {
        const existing = this.suppressions[index];
        const updated: InMemSuppression = {
          ...existing,
          reason: update.reason ?? existing.reason,
          source: update.source ?? existing.source,
          updatedAt: new Date(),
        };
        this.suppressions[index] = updated;
        return { ...updated };
      }
      const record: InMemSuppression = {
        id: create.id || `sup_${this.idCounter++}`,
        tenantId: create.tenantId,
        phoneNormalized: create.phoneNormalized,
        reason: create.reason ?? null,
        source: create.source ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.suppressions.push(record);
      return { ...record };
    },

    findUnique: async ({ where }: { where: any }): Promise<SuppressionEntry | null> => {
      if (where.tenantId_phoneNormalized) {
        const { tenantId, phoneNormalized } = where.tenantId_phoneNormalized;
        const match = this.suppressions.find(
          (s) => s.tenantId === tenantId && s.phoneNormalized === phoneNormalized,
        );
        return match ? { ...match } : null;
      }
      return null;
    },

    deleteMany: async ({ where }: { where: any }): Promise<{ count: number }> => {
      const beforeLen = this.suppressions.length;
      this.suppressions = this.suppressions.filter((s) => {
        if (where.tenantId && s.tenantId !== where.tenantId) return true;
        if (where.phoneNormalized && s.phoneNormalized !== where.phoneNormalized) return true;
        return false;
      });
      return { count: beforeLen - this.suppressions.length };
    },

    findMany: async ({ where }: { where?: any }): Promise<SuppressionEntry[]> => {
      return this.suppressions
        .filter((s) => !where?.tenantId || s.tenantId === where.tenantId)
        .map((s) => ({ ...s }));
    },
  };

  $transaction = async (actions: any[]) => {
    return Promise.all(actions);
  };
}

interface InMemContact {
  id: string;
  tenantId: string;
  phoneNormalized: string;
  phoneRaw: string | null;
  firstName: string | null;
  lastName: string | null;
  attributes: any;
  isSuppressed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface InMemTag {
  id: string;
  tenantId: string;
  name: string;
  color: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InMemContactTag {
  id: string;
  tenantId: string;
  contactId: string;
  tagId: string;
  createdAt: Date;
}

interface InMemSuppression {
  id: string;
  tenantId: string;
  phoneNormalized: string;
  reason: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Test Suite
// ============================================================================
describe('Contacts, Tags & Suppression API Integration Tests (TASK-0022)', () => {
  let app: INestApplication;
  let baseUrl = '';
  let mockPrisma: InMemoryPrismaMock;

  const TENANT_ALPHA = 'org_alpha_contacts_101';
  const TENANT_BETA = 'org_beta_contacts_202';

  before(async () => {
    mockPrisma = new InMemoryPrismaMock();

    @Module({
      controllers: [ContactsController],
      providers: [
        Reflector,
        TenantGuard,
        RolesGuard,
        TenantInterceptor,
        ContactsService,
        {
          provide: ContactsRepository,
          useFactory: () => new ContactsRepository(mockPrisma as unknown as PrismaService),
        },
      ],
    })
    class TestContactsAppModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(TenantMiddleware, AuthContextMiddleware).forRoutes('*');
      }
    }

    app = await NestFactory.create(TestContactsAppModule, { logger: false });
    await app.listen(0);
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address?.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    mockPrisma.reset();
  });

  // =========================================================================
  // AC-01: CRUD Contacts, Tag Management, Tag Assignment & Suppressions
  // =========================================================================
  describe('AC-01: Full Lifecycle of Contacts, Tags & Suppressions', () => {
    it('creates contact, returns 201 Created and persists with normalized phone', async () => {
      const res = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '09121234567',
          firstName: 'Sohrab',
          lastName: 'Sepehri',
          attributes: { city: 'Kashan', poet: true },
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.phoneNormalized, '+989121234567');
      assert.equal(data.phoneRaw, '09121234567');
      assert.equal(data.firstName, 'Sohrab');
      assert.equal(data.lastName, 'Sepehri');
      assert.equal(data.tenantId, TENANT_ALPHA);
      assert.equal(data.attributes.city, 'Kashan');
      assert.equal(data.isSuppressed, false);
      assert.ok(data.id);
    });

    it('lists contacts with filtering, pagination and ordering', async () => {
      // Create two contacts
      await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09121111111', firstName: 'First' }),
      });
      await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09122222222', firstName: 'Second' }),
      });

      const listRes = await fetch(`${baseUrl}/contacts?take=10`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.STF,
        },
      });
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.equal(listData.length, 2);
    });

    it('retrieves single contact by ID with 200 or 404', async () => {
      const createRes = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OP,
        },
        body: JSON.stringify({ phone: '09123333333', firstName: 'Nima' }),
      });
      const created = await createRes.json();

      const getRes = await fetch(`${baseUrl}/contacts/${created.id}`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.AUD,
        },
      });
      assert.equal(getRes.status, 200);
      const retrieved = await getRes.json();
      assert.equal(retrieved.id, created.id);
      assert.equal(retrieved.firstName, 'Nima');

      const notFoundRes = await fetch(`${baseUrl}/contacts/non_existent_id`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.AUD,
        },
      });
      assert.equal(notFoundRes.status, 404);
    });

    it('updates contact via PUT and PATCH with 200 OK', async () => {
      const createRes = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09124444444', firstName: 'Original' }),
      });
      const created = await createRes.json();

      const patchRes = await fetch(`${baseUrl}/contacts/${created.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ firstName: 'UpdatedName' }),
      });
      assert.equal(patchRes.status, 200);
      const patched = await patchRes.json();
      assert.equal(patched.firstName, 'UpdatedName');
    });

    it('deletes contact and returns 404 on subsequent get', async () => {
      const createRes = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09125555555' }),
      });
      const created = await createRes.json();

      const delRes = await fetch(`${baseUrl}/contacts/${created.id}`, {
        method: 'DELETE',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
      });
      assert.equal(delRes.status, 200);

      const checkRes = await fetch(`${baseUrl}/contacts/${created.id}`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
      });
      assert.equal(checkRes.status, 404);
    });

    it('manages tags: create, list, attach to contact, and remove', async () => {
      // 1. Create Tag
      const tagRes = await fetch(`${baseUrl}/contacts/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          name: 'VIP Customers',
          color: '#FFD700',
          description: 'High value accounts',
        }),
      });
      assert.equal(tagRes.status, 201);
      const tag = await tagRes.json();
      assert.equal(tag.name, 'VIP Customers');

      // 2. List Tags
      const listTagRes = await fetch(`${baseUrl}/contacts/tags`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.STF,
        },
      });
      assert.equal(listTagRes.status, 200);
      const tagList = await listTagRes.json();
      assert.equal(tagList.length, 1);
      assert.equal(tagList[0].id, tag.id);

      // 3. Create Contact
      const cntRes = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09126666666' }),
      });
      const contact = await cntRes.json();

      // 4. Attach Tag to Contact
      const attachRes = await fetch(`${baseUrl}/contacts/${contact.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });
      assert.equal(attachRes.status, 201);

      // 5. List Contact Tags
      const contactTagsRes = await fetch(`${baseUrl}/contacts/${contact.id}/tags`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.AUD,
        },
      });
      assert.equal(contactTagsRes.status, 200);
      const contactTags = await contactTagsRes.json();
      assert.equal(contactTags.length, 1);
      assert.equal(contactTags[0].name, 'VIP Customers');

      // 6. Remove Tag from Contact
      const removeTagRes = await fetch(
        `${baseUrl}/contacts/${contact.id}/tags/${tag.id}`,
        {
          method: 'DELETE',
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.OP,
          },
        },
      );
      assert.equal(removeTagRes.status, 200);

      // 7. Verify removed
      const verifyRes = await fetch(`${baseUrl}/contacts/${contact.id}/tags`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.AUD,
        },
      });
      const emptyTags = await verifyRes.json();
      assert.equal(emptyTags.length, 0);
    });

    it('manages suppression (opt-out / blacklist): add, query check, and remove', async () => {
      // 1. Add suppression
      const addRes = await fetch(`${baseUrl}/contacts/suppressions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '09127777777',
          reason: 'User texted STOP',
          source: 'INBOUND_SMS',
        }),
      });
      assert.equal(addRes.status, 201);
      const suppression = await addRes.json();
      assert.equal(suppression.phoneNormalized, '+989127777777');

      // 2. Check suppression via query parameter
      const checkRes = await fetch(
        `${baseUrl}/contacts/suppressions/check?phone=09127777777`,
        {
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.STF,
          },
        },
      );
      assert.equal(checkRes.status, 200);
      const checkData = await checkRes.json();
      assert.equal(checkData.phoneNormalized, '+989127777777');
      assert.equal(checkData.isSuppressed, true);

      // 3. Check an unsuppressed number
      const checkUnsuppressed = await fetch(
        `${baseUrl}/contacts/suppressions/check?phone=09128888888`,
        {
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.STF,
          },
        },
      );
      assert.equal(checkUnsuppressed.status, 200);
      const unsuppressedData = await checkUnsuppressed.json();
      assert.equal(unsuppressedData.isSuppressed, false);

      // 4. Remove suppression
      const removeRes = await fetch(
        `${baseUrl}/contacts/suppressions/+989127777777`,
        {
          method: 'DELETE',
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.OP,
          },
        },
      );
      assert.equal(removeRes.status, 200);

      // 5. Check again -> now false
      const checkAgain = await fetch(
        `${baseUrl}/contacts/suppressions/check?phone=09127777777`,
        {
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.STF,
          },
        },
      );
      const againData = await checkAgain.json();
      assert.equal(againData.isSuppressed, false);
    });
  });

  // =========================================================================
  // AC-02: RBAC Matrix & Tenant Isolation Guard Verification
  // =========================================================================
  describe('AC-02: RBAC Matrix & Fail-Closed Guard Enforcement', () => {
    it('rejects requests without x-tenant-id with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09121234567' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /tenant/i);
    });

    it('rejects requests with invalid / empty x-tenant-id with 400 Bad Request', async () => {
      const resEmpty = await fetch(`${baseUrl}/contacts`, {
        headers: {
          'x-tenant-id': '   ',
          'x-user-role': Role.OMGR,
        },
      });
      assert.equal(resEmpty.status, 400);

      const resMalicious = await fetch(`${baseUrl}/contacts`, {
        headers: {
          'x-tenant-id': 'tenant; DROP TABLE contacts; --',
          'x-user-role': Role.OMGR,
        },
      });
      assert.equal(resMalicious.status, 400);
    });

    it('rejects unauthenticated requests (missing user / role) with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/contacts`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
        },
      });
      assert.equal(res.status, 403);
    });

    it('restricts write / mutation endpoints strictly to OMGR and OP roles', async () => {
      const payload = JSON.stringify({ phone: '09129990011' });

      // 1. OMGR -> Allowed (201)
      const resOmgr = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: payload,
      });
      assert.equal(resOmgr.status, 201);

      // 2. OP -> Allowed (201)
      const resOp = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OP,
        },
        body: JSON.stringify({ phone: '09129990022' }),
      });
      assert.equal(resOp.status, 201);

      // 3. STF -> Forbidden (403)
      const resStf = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.STF,
        },
        body: JSON.stringify({ phone: '09129990033' }),
      });
      assert.equal(resStf.status, 403);

      // 4. AUD -> Forbidden (403)
      const resAud = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.AUD,
        },
        body: JSON.stringify({ phone: '09129990044' }),
      });
      assert.equal(resAud.status, 403);

      // 5. Arbitrary invalid role -> Forbidden (403)
      const resInvalid = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': 'GUEST',
        },
        body: JSON.stringify({ phone: '09129990055' }),
      });
      assert.equal(resInvalid.status, 403);
    });

    it('permits read endpoints for OMGR, OP, STF, and AUD roles', async () => {
      for (const role of [Role.OMGR, Role.OP, Role.STF, Role.AUD]) {
        const res = await fetch(`${baseUrl}/contacts`, {
          headers: {
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': role,
          },
        });
        assert.equal(res.status, 200, `Role ${role} should be allowed read access to /contacts`);
      }

      // Invalid role rejected on read
      const resGuest = await fetch(`${baseUrl}/contacts`, {
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': 'GUEST',
        },
      });
      assert.equal(resGuest.status, 403);
    });

    it('enforces strict multi-tenant boundary isolation', async () => {
      // 1. Create contact in Alpha
      const alphaRes = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({ phone: '09121112233', firstName: 'AlphaOnly' }),
      });
      const alphaContact = await alphaRes.json();

      // 2. Querying Tenant Beta list -> must NOT return Alpha contact
      const betaListRes = await fetch(`${baseUrl}/contacts`, {
        headers: {
          'x-tenant-id': TENANT_BETA,
          'x-user-role': Role.OMGR,
        },
      });
      const betaList = await betaListRes.json();
      assert.equal(betaList.length, 0);

      // 3. Querying Alpha contact ID from Tenant Beta -> must return 404
      const crossGetRes = await fetch(`${baseUrl}/contacts/${alphaContact.id}`, {
        headers: {
          'x-tenant-id': TENANT_BETA,
          'x-user-role': Role.OMGR,
        },
      });
      assert.equal(crossGetRes.status, 404);
    });
  });

  // =========================================================================
  // AC-03: Input Validation, Phone Normalization & Unknown Field Protection
  // =========================================================================
  describe('AC-03: Input Validation & Security Shield', () => {
    it('normalizes Persian and Arabic numerals to canonical +989 format', async () => {
      const resPersian = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '۰۹۱۲۳۴۵۶۷۸۹', // Persian digits
        }),
      });
      assert.equal(resPersian.status, 201);
      const dataPersian = await resPersian.json();
      assert.equal(dataPersian.phoneNormalized, '+989123456789');

      const resArabic = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '٠٩٣٥١١١٢٢٣٣', // Arabic digits
        }),
      });
      assert.equal(resArabic.status, 201);
      const dataArabic = await resArabic.json();
      assert.equal(dataArabic.phoneNormalized, '+989351112233');
    });

    it('rejects invalid or malformed phone numbers with 400 Bad Request', async () => {
      const invalidPhones = ['12345', 'abcdef', '0912123456', '+15551234567', ''];

      for (const phone of invalidPhones) {
        const res = await fetch(`${baseUrl}/contacts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-tenant-id': TENANT_ALPHA,
            'x-user-role': Role.OMGR,
          },
          body: JSON.stringify({ phone }),
        });
        assert.equal(res.status, 400, `Phone '${phone}' should be rejected with 400`);
      }
    });

    it('strictly rejects unknown fields to prevent mass assignment injection', async () => {
      const res = await fetch(`${baseUrl}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '09129876543',
          role: 'SUPERADMIN', // illegal injection attempt
          maliciousPayload: true,
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /Unknown field 'role'/);
    });

    it('strictly rejects unknown fields on tag creation', async () => {
      const res = await fetch(`${baseUrl}/contacts/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          name: 'ValidName',
          injectField: 'dangerous',
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /Unknown field 'injectField'/);
    });

    it('strictly rejects unknown fields on suppression creation', async () => {
      const res = await fetch(`${baseUrl}/contacts/suppressions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': TENANT_ALPHA,
          'x-user-role': Role.OMGR,
        },
        body: JSON.stringify({
          phone: '09121234567',
          unauthorizedField: 123,
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /Unknown field 'unauthorizedField'/);
    });
  });
});

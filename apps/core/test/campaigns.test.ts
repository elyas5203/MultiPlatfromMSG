import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CampaignRepository,
  CampaignService,
  CampaignStatus,
  AudienceEmptyError,
  CampaignStateError,
} from '../src/campaigns';
import { ContactsRepository } from '../src/contacts/contacts.repository';
import { BillingRepository } from '../src/billing/billing.repository';
import { DispatcherService } from '../src/messaging/dispatcher.service';
import { SenderRoutingEngine } from '../src/senders/routing-engine';
import { KillSwitchService } from '../src/messaging/kill-switch.service';
import { DispatchRateLimiter } from '../src/messaging/rate-limiter';
import { TelegramConnector, TelegramTransportAdapter } from '../src/messaging/connectors/telegram.connector';
import { BaleConnector } from '../src/messaging/connectors/bale.connector';
import { TenantScopeMissingError, TenantScopeInvalidError } from '../src/tenant/tenant-scope';

describe('Phase 7: Campaign Management, Audience Targeting, Batch Scheduling & Execution Pipeline', () => {
  const TENANT_A = 'tenant_camp_a';
  const TENANT_B = 'tenant_camp_b';

  let campaignRepo: CampaignRepository;
  let contactsRepo: ContactsRepository;
  let billingRepo: BillingRepository;
  let routingEngine: SenderRoutingEngine;
  let killSwitch: KillSwitchService;
  let rateLimiter: DispatchRateLimiter;
  let tgConnector: TelegramConnector;
  let baleConnector: BaleConnector;
  let dispatcher: DispatcherService;
  let campaignService: CampaignService;

  // Mock PrismaService for in-memory Contacts & Billing repositories
  let mockPrisma: any;

  beforeEach(() => {
    // In-memory data stores for contacts & billing
    const contactsStore = new Map<string, any>();
    const tagsStore = new Map<string, any>();
    const contactTagsStore = new Map<string, any>();
    const suppressionsStore = new Map<string, any>();
    const accountsStore = new Map<string, any>();
    const ledgerEntriesStore: any[] = [];
    const reservationsStore = new Map<string, any>();

    mockPrisma = {
      contact: {
        findUnique: async ({ where }: any) => {
          if (where.tenantId_phoneNormalized) {
            const key = `${where.tenantId_phoneNormalized.tenantId}:${where.tenantId_phoneNormalized.phoneNormalized}`;
            return contactsStore.get(key) || null;
          }
          return null;
        },
        findFirst: async ({ where }: any) => {
          for (const c of contactsStore.values()) {
            if (c.tenantId === where.tenantId && c.id === where.id) {
              return c;
            }
          }
          return null;
        },
        findMany: async ({ where }: any) => {
          let list = Array.from(contactsStore.values()).filter((c) => c.tenantId === where.tenantId);
          if (where.isSuppressed !== undefined) {
            list = list.filter((c) => c.isSuppressed === where.isSuppressed);
          }
          return list;
        },
        create: async ({ data }: any) => {
          const id = data.id || `cnt_${Date.now()}_${Math.random()}`;
          const contact = { ...data, id, createdAt: new Date(), updatedAt: new Date() };
          const key = `${data.tenantId}:${data.phoneNormalized}`;
          contactsStore.set(key, contact);
          return contact;
        },
        update: async ({ where, data }: any) => {
          for (const [key, c] of contactsStore.entries()) {
            if (c.tenantId === where.tenantId_id.tenantId && c.id === where.tenantId_id.id) {
              const updated = { ...c, ...data, updatedAt: new Date() };
              contactsStore.set(key, updated);
              return updated;
            }
          }
          throw new Error('Contact not found');
        },
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const [key, c] of contactsStore.entries()) {
            if (c.tenantId === where.tenantId && c.phoneNormalized === where.phoneNormalized) {
              Object.assign(c, data);
              count++;
            }
          }
          return { count };
        },
      },
      tag: {
        findFirst: async ({ where }: any) => {
          for (const t of tagsStore.values()) {
            if (t.tenantId === where.tenantId && t.id === where.id) return t;
          }
          return null;
        },
        findMany: async ({ where }: any) => {
          return Array.from(tagsStore.values()).filter((t) => t.tenantId === where.tenantId);
        },
        create: async ({ data }: any) => {
          const id = data.id || `tag_${Date.now()}`;
          const tag = { ...data, id };
          tagsStore.set(`${data.tenantId}:${id}`, tag);
          return tag;
        },
      },
      contactTag: {
        findMany: async ({ where, include }: any) => {
          const list: any[] = [];
          for (const ct of contactTagsStore.values()) {
            if (ct.tenantId === where.tenantId && ct.contactId === where.contactId) {
              if (include?.tag) {
                const tag = tagsStore.get(`${ct.tenantId}:${ct.tagId}`);
                list.push({ ...ct, tag });
              } else {
                list.push(ct);
              }
            }
          }
          return list;
        },
        create: async ({ data }: any) => {
          const id = `ct_${Date.now()}_${Math.random()}`;
          const entry = { ...data, id };
          contactTagsStore.set(`${data.tenantId}:${data.contactId}:${data.tagId}`, entry);
          return entry;
        },
      },
      suppressionEntry: {
        findUnique: async ({ where }: any) => {
          const key = `${where.tenantId_phoneNormalized.tenantId}:${where.tenantId_phoneNormalized.phoneNormalized}`;
          return suppressionsStore.get(key) || null;
        },
        findMany: async ({ where }: any) => {
          return Array.from(suppressionsStore.values()).filter((s) => s.tenantId === where.tenantId);
        },
        upsert: async ({ where, create, update }: any) => {
          const key = `${where.tenantId_phoneNormalized.tenantId}:${where.tenantId_phoneNormalized.phoneNormalized}`;
          const existing = suppressionsStore.get(key);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const id = create.id || `sup_${Date.now()}`;
          const entry = { ...create, id, createdAt: new Date() };
          suppressionsStore.set(key, entry);
          return entry;
        },
      },
      account: {
        findFirst: async ({ where }: any) => {
          for (const a of accountsStore.values()) {
            if (a.tenantId === where.tenantId && a.id === where.id) return a;
          }
          return null;
        },
        findMany: async ({ where }: any) => {
          return Array.from(accountsStore.values()).filter((a) => a.tenantId === where.tenantId);
        },
        create: async ({ data }: any) => {
          const id = data.id || `acc_${Date.now()}`;
          const acc = { ...data, id, creditLimit: BigInt(0), status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
          accountsStore.set(`${data.tenantId}:${id}`, acc);
          return acc;
        },
      },
      ledgerEntry: {
        findFirst: async ({ where, orderBy }: any) => {
          let list = ledgerEntriesStore.filter(
            (e) => e.tenantId === where.tenantId && (!where.accountId || e.accountId === where.accountId),
          );
          if (orderBy?.sequence === 'desc') {
            list = [...list].sort((a, b) => (b.sequence > a.sequence ? 1 : -1));
          }
          return list[0] || null;
        },
        findMany: async ({ where }: any) => {
          return ledgerEntriesStore.filter((e) => e.tenantId === where.tenantId);
        },
        create: async ({ data }: any) => {
          const entry = { ...data, id: `led_${Date.now()}`, sequence: BigInt(ledgerEntriesStore.length + 1), timestamp: new Date() };
          ledgerEntriesStore.push(entry);
          return entry;
        },
      },
      creditReservation: {
        findFirst: async ({ where }: any) => {
          for (const r of reservationsStore.values()) {
            if (r.tenantId === where.tenantId && r.id === where.id) return r;
          }
          return null;
        },
        findMany: async ({ where }: any) => {
          return Array.from(reservationsStore.values()).filter((r) => r.tenantId === where.tenantId);
        },
        create: async ({ data }: any) => {
          const id = data.id || `res_${Date.now()}`;
          const res = {
            ...data,
            id,
            settledAmount: BigInt(0),
            releasedAmount: BigInt(0),
            status: 'ACTIVE',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          reservationsStore.set(`${data.tenantId}:${id}`, res);
          return res;
        },
        update: async ({ where, data }: any) => {
          let r: any = null;
          if (where.tenantId_id) {
            r = reservationsStore.get(`${where.tenantId_id.tenantId}:${where.tenantId_id.id}`);
          } else if (where.id) {
            for (const val of reservationsStore.values()) {
              if (val.id === where.id) {
                r = val;
                break;
              }
            }
          }
          if (!r) throw new Error("Reservation not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return r;
        },
      },
      $transaction: async (cb: any) => cb(mockPrisma),
    };

    campaignRepo = new CampaignRepository();
    contactsRepo = new ContactsRepository(mockPrisma);
    billingRepo = new BillingRepository(mockPrisma);
    routingEngine = new SenderRoutingEngine();
    killSwitch = new KillSwitchService();
    rateLimiter = new DispatchRateLimiter();
    tgConnector = new TelegramConnector();
    baleConnector = new BaleConnector();
    dispatcher = new DispatcherService(killSwitch, rateLimiter, tgConnector, baleConnector);

    campaignService = new CampaignService(
      campaignRepo,
      contactsRepo,
      billingRepo,
      dispatcher,
      routingEngine,
      killSwitch,
    );

    // Register active sender account for TG in routing engine
    routingEngine.registerSender({
      id: 'sender_tg_marketing',
      tenantId: TENANT_A,
      name: 'Marketing Bot',
      channel: 'TELEGRAM',
      type: 'CUSTOMER_CONNECTED',
      status: 'ACTIVE',
      dailyQuota: 500,
      sentTodayCount: 0,
      activeWorkloadCount: 0,
    });
  });

  describe('1. Campaign Creation & Draft State', () => {
    it('should create a valid campaign in DRAFT state with required properties', async () => {
      const campaign = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین تخفیف یلدا',
        channel: 'TELEGRAM',
        templateText: 'تخفیف ویژه ۵۰ درصدی یلدا برای شما!',
        costPerMessage: 25,
      });

      assert.ok(campaign.id);
      assert.strictEqual(campaign.tenantId, TENANT_A);
      assert.strictEqual(campaign.title, 'کمپین تخفیف یلدا');
      assert.strictEqual(campaign.channel, 'TELEGRAM');
      assert.strictEqual(campaign.status, 'DRAFT');
      assert.strictEqual(campaign.costPerMessage, 25);
      assert.strictEqual(campaign.totalRecipients, 0);
      assert.strictEqual(campaign.sentCount, 0);
    });

    it('should reject creation when title, channel, or templateText is missing', async () => {
      await assert.rejects(
        async () => {
          await campaignService.createCampaign(TENANT_A, {
            title: '',
            channel: 'TELEGRAM',
            templateText: 'Text',
          });
        },
        /Campaign title is required/,
      );

      await assert.rejects(
        async () => {
          await campaignService.createCampaign(TENANT_A, {
            title: 'Test',
            channel: '' as any,
            templateText: 'Text',
          });
        },
        /Campaign channel is required/,
      );
    });
  });

  describe('2. Audience Resolution & Zero-Exception Suppression Exclusion', () => {
    it('should resolve eligible contacts while strictly excluding suppressed contacts (Opt-out)', async () => {
      // Create 3 contacts: 2 active, 1 suppressed
      await contactsRepo.createContact(TENANT_A, {
        phoneNormalized: '+989121110001',
        firstName: 'Ali',
        isSuppressed: false,
      });
      await contactsRepo.createContact(TENANT_A, {
        phoneNormalized: '+989121110002',
        firstName: 'Reza',
        isSuppressed: false,
      });
      await contactsRepo.createContact(TENANT_A, {
        phoneNormalized: '+989121110003',
        firstName: 'Sara',
        isSuppressed: true, // Blacklisted
      });

      // Also add explicit phone to suppression table
      await contactsRepo.addSuppression(TENANT_A, {
        phoneNormalized: '+989121110002',
        reason: 'User opted out via SMS',
      });

      const res = await campaignService.resolveAudience(TENANT_A);
      // Only Ali (+989121110001) should remain eligible!
      assert.strictEqual(res.eligibleContacts.length, 1);
      assert.strictEqual(res.eligibleContacts[0].phoneNormalized, '+989121110001');
      assert.strictEqual(res.suppressedCount, 2);
    });

    it('should throw AudienceEmptyError when no eligible contacts match', async () => {
      await assert.rejects(
        async () => {
          await campaignService.resolveAudience(TENANT_A);
        },
        AudienceEmptyError,
      );
    });
  });

  describe('3. Two-Phase Financial Credit Reservation & Scheduling', () => {
    it('should calculate cost, reserve credit in Billing, and partition batches', async () => {
      // Setup 5 eligible contacts
      for (let i = 1; i <= 5; i++) {
        await contactsRepo.createContact(TENANT_A, {
          phoneNormalized: `+98912000000${i}`,
          isSuppressed: false,
        });
      }

      // Fund tenant wallet
      const wallet = await billingRepo.createAccount(TENANT_A, {
        name: 'Primary Wallet',
        type: 'CUSTOMER_PREPAID',
        currency: 'IRR',
      });
      await billingRepo.appendEntry(TENANT_A, {
        tenantId: TENANT_A,
        accountId: wallet.id,
        entryType: 'CREDIT',
        amount: BigInt(1000),
        purpose: 'INITIAL_TOPUP',
        referenceId: 'topup_01',
      });

      const campaign = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین تخفیف ۵۰ تومانی',
        channel: 'TELEGRAM',
        templateText: 'پیام تست برای زمان‌بندی',
        costPerMessage: 20, // 5 * 20 = 100 required credit
      });

      // Schedule campaign with batch size of 2 (should create 3 batches: 2, 2, 1)
      const scheduled = await campaignService.scheduleCampaign(TENANT_A, campaign.id, {
        batchSize: 2,
      });

      assert.strictEqual(scheduled.status, 'SCHEDULED');
      assert.strictEqual(scheduled.totalRecipients, 5);
      assert.ok(scheduled.reservationId);

      // Verify batches created
      const batches = await campaignRepo.listBatches(TENANT_A, campaign.id);
      assert.strictEqual(batches.length, 3);
      assert.strictEqual(batches[0].size, 2);
      assert.strictEqual(batches[1].size, 2);
      assert.strictEqual(batches[2].size, 1);

      // Verify reservation amount in billing = 100
      const reservation = await billingRepo.findReservationById(TENANT_A, scheduled.reservationId!);
      assert.strictEqual(reservation?.amount, BigInt(100));
      assert.strictEqual(reservation?.status, 'ACTIVE');
    });
  });

  describe('4. Batch Execution Pipeline & Settlement', () => {
    it('should dispatch batches, update counters, and settle billing reservation upon completion', async () => {
      // Setup 3 contacts
      for (let i = 1; i <= 3; i++) {
        await contactsRepo.createContact(TENANT_A, {
          phoneNormalized: `+98912111110${i}`,
          isSuppressed: false,
        });
      }

      // Fund wallet
      const wallet = await billingRepo.createAccount(TENANT_A, {
        name: 'Primary Wallet',
        type: 'CUSTOMER_PREPAID',
        currency: 'IRR',
      });
      await billingRepo.appendEntry(TENANT_A, {
        tenantId: TENANT_A,
        accountId: wallet.id,
        entryType: 'CREDIT',
        amount: BigInt(500),
        purpose: 'TOPUP',
        referenceId: 'topup_02',
      });

      const campaign = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین ارسال قطعی',
        channel: 'TELEGRAM',
        templateText: 'متن پیام ارسال نهایی',
        costPerMessage: 30, // 3 * 30 = 90
      });

      await campaignService.scheduleCampaign(TENANT_A, campaign.id, { batchSize: 10 });

      // Execute campaign
      const report = await campaignService.executeCampaign(TENANT_A, campaign.id);

      assert.strictEqual(report.status, 'COMPLETED');
      assert.strictEqual(report.sentCount, 3);
      assert.strictEqual(report.failedCount, 0);
      assert.strictEqual(report.settledAmount, 90);

      // Progress check
      const progress = await campaignService.getProgress(TENANT_A, campaign.id);
      assert.strictEqual(progress.status, 'COMPLETED');
      assert.strictEqual(progress.progressPercentage, 100);
      assert.strictEqual(progress.batchesCompleted, 1);
    });
  });

  describe('5. Pause, Resume, and Cancellation Controls', () => {
    it('should pause, resume, and cancel campaign with reservation release', async () => {
      // 1 contact
      await contactsRepo.createContact(TENANT_A, {
        phoneNormalized: '+989129998877',
        isSuppressed: false,
      });

      const wallet = await billingRepo.createAccount(TENANT_A, {
        name: 'Primary Wallet',
        type: 'CUSTOMER_PREPAID',
        currency: 'IRR',
      });
      await billingRepo.appendEntry(TENANT_A, {
        tenantId: TENANT_A,
        accountId: wallet.id,
        entryType: 'CREDIT',
        amount: BigInt(500),
        purpose: 'TOPUP',
        referenceId: 'topup_03',
      });

      const campaign = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین مکث و لغو',
        channel: 'TELEGRAM',
        templateText: 'پیام تستی',
        costPerMessage: 10,
      });

      const scheduled = await campaignService.scheduleCampaign(TENANT_A, campaign.id);
      assert.strictEqual(scheduled.status, 'SCHEDULED');

      // Pause
      const paused = await campaignService.pauseCampaign(TENANT_A, campaign.id);
      assert.strictEqual(paused.status, 'PAUSED');

      // Resume
      const resumed = await campaignService.resumeCampaign(TENANT_A, campaign.id);
      assert.strictEqual(resumed.status, 'SCHEDULED');

      // Cancel
      const cancelled = await campaignService.cancelCampaign(TENANT_A, campaign.id, 'User cancelled');
      assert.strictEqual(cancelled.status, 'CANCELLED');

      // Reservation must be released
      const res = await billingRepo.findReservationById(TENANT_A, scheduled.reservationId!);
      assert.strictEqual(res?.status, 'RELEASED');
    });
  });

  describe('6. Emergency Kill Switch Halting', () => {
    it('should immediately fail-closed and abort campaign execution when Kill Switch is active', async () => {
      await contactsRepo.createContact(TENANT_A, {
        phoneNormalized: '+989120000099',
        isSuppressed: false,
      });

      const wallet = await billingRepo.createAccount(TENANT_A, {
        name: 'Primary Wallet',
        type: 'CUSTOMER_PREPAID',
        currency: 'IRR',
      });
      await billingRepo.appendEntry(TENANT_A, {
        tenantId: TENANT_A,
        accountId: wallet.id,
        entryType: 'CREDIT',
        amount: BigInt(500),
        purpose: 'TOPUP',
        referenceId: 'topup_05',
      });

      const campaign = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین بحران',
        channel: 'TELEGRAM',
        templateText: 'متن در شرایط بحران',
      });

      await campaignService.scheduleCampaign(TENANT_A, campaign.id);

      // Trigger global kill switch
      killSwitch.activate({
        reason: 'Emergency Kill Switch Triggered',
        triggeredBy: 'SecurityOps',
      });

      await assert.rejects(
        async () => {
          await campaignService.executeCampaign(TENANT_A, campaign.id);
        },
        /Kill Switch is ACTIVE/,
      );
    });
  });

  describe('7. Zero Cross-Tenant Isolation Enforcement', () => {
    it('should strictly reject access to campaigns belonging to another tenant', async () => {
      const campaignA = await campaignService.createCampaign(TENANT_A, {
        title: 'کمپین سازمان الف',
        channel: 'TELEGRAM',
        templateText: 'پیام محرمانه الف',
      });

      await assert.rejects(
        async () => {
          await campaignService.getCampaign(TENANT_B, campaignA.id);
        },
        /not found for tenant 'tenant_camp_b'/,
      );
    });

    it('should reject missing or illegal tenantId', async () => {
      await assert.rejects(
        async () => {
          await campaignService.createCampaign('', {
            title: 'کمپین بدون مستأجر',
            channel: 'TELEGRAM',
            templateText: 'تست',
          });
        },
        TenantScopeMissingError,
      );

      await assert.rejects(
        async () => {
          await campaignService.createCampaign('invalid tenant id with spaces!', {
            title: 'تست',
            channel: 'TELEGRAM',
            templateText: 'تست',
          });
        },
        TenantScopeInvalidError,
      );
    });
  });
});

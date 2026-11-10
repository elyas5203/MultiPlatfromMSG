import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  Contact,
  Tag,
  ContactTag,
  SuppressionEntry,
  CreateContactInput,
  UpdateContactInput,
  ListContactsOptions,
  CreateTagInput,
  AddSuppressionInput,
} from './types';
import { Prisma } from '@prisma/client';

export class ContactNotFoundError extends Error {
  constructor(message = 'Contact not found within tenant scope.') {
    super(message);
    this.name = 'ContactNotFoundError';
  }
}

export class TagNotFoundError extends Error {
  constructor(message = 'Tag not found within tenant scope.') {
    super(message);
    this.name = 'TagNotFoundError';
  }
}

@Injectable()
export class ContactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== Contact Operations ====================

  /**
   * Creates a new contact strictly scoped to the tenant.
   * If the phone number is currently in the suppression list for this tenant,
   * isSuppressed defaults to true unless explicitly overridden.
   */
  async createContact(tenantId: unknown, input: CreateContactInput): Promise<Contact> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!input || !input.phoneNormalized || typeof input.phoneNormalized !== 'string') {
      throw new Error('phoneNormalized is required and must be a non-empty string.');
    }

    const normalizedPhone = input.phoneNormalized.trim();
    if (normalizedPhone.length === 0) {
      throw new Error('phoneNormalized cannot be empty.');
    }

    let isSuppressed = input.isSuppressed;
    if (isSuppressed === undefined) {
      const suppression = await this.prisma.suppressionEntry.findUnique({
        where: {
          tenantId_phoneNormalized: {
            tenantId: validTenantId,
            phoneNormalized: normalizedPhone,
          },
        },
      });
      isSuppressed = suppression !== null;
    }

    return this.prisma.contact.create({
      data: {
        id: input.id,
        tenantId: validTenantId,
        phoneNormalized: normalizedPhone,
        phoneRaw: input.phoneRaw?.trim() ?? null,
        firstName: input.firstName?.trim() ?? null,
        lastName: input.lastName?.trim() ?? null,
        attributes: (input.attributes as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        isSuppressed,
      },
    });
  }

  /**
   * Finds a contact by its ID strictly within the specified tenant.
   */
  async findContactById(tenantId: unknown, contactId: string): Promise<Contact | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!contactId || typeof contactId !== 'string' || contactId.trim().length === 0) {
      return null;
    }

    return this.prisma.contact.findFirst({
      where: {
        id: contactId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  /**
   * Finds a contact by normalized phone strictly within the tenant scope.
   */
  async findContactByPhone(tenantId: unknown, phoneNormalized: string): Promise<Contact | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!phoneNormalized || typeof phoneNormalized !== 'string' || phoneNormalized.trim().length === 0) {
      return null;
    }

    return this.prisma.contact.findUnique({
      where: {
        tenantId_phoneNormalized: {
          tenantId: validTenantId,
          phoneNormalized: phoneNormalized.trim(),
        },
      },
    });
  }

  /**
   * Lists contacts strictly scoped to the tenant.
   */
  async listContacts(tenantId: unknown, options?: ListContactsOptions): Promise<Contact[]> {
    const validTenantId = assertValidTenantId(tenantId);

    const where: Prisma.ContactWhereInput = {
      tenantId: validTenantId,
    };

    if (options?.isSuppressed !== undefined) {
      where.isSuppressed = options.isSuppressed;
    }

    if (options?.searchPhone) {
      where.phoneNormalized = {
        contains: options.searchPhone.trim(),
      };
    }

    if (options?.tagId) {
      where.contactTags = {
        some: {
          tenantId: validTenantId,
          tagId: options.tagId.trim(),
        },
      };
    }

    return this.prisma.contact.findMany({
      where,
      take: options?.take,
      skip: options?.skip,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Updates a contact within the tenant boundary.
   */
  async updateContact(
    tenantId: unknown,
    contactId: string,
    data: UpdateContactInput,
  ): Promise<Contact> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findContactById(validTenantId, contactId);
    if (!existing) {
      throw new ContactNotFoundError();
    }

    const updateData: Prisma.ContactUpdateInput = {};
    if (data.phoneNormalized !== undefined) {
      updateData.phoneNormalized = data.phoneNormalized.trim();
    }
    if (data.phoneRaw !== undefined) {
      updateData.phoneRaw = data.phoneRaw?.trim() ?? null;
    }
    if (data.firstName !== undefined) {
      updateData.firstName = data.firstName?.trim() ?? null;
    }
    if (data.lastName !== undefined) {
      updateData.lastName = data.lastName?.trim() ?? null;
    }
    if (data.attributes !== undefined) {
      updateData.attributes = (data.attributes as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
    if (data.isSuppressed !== undefined) {
      updateData.isSuppressed = data.isSuppressed;
    }

    return this.prisma.contact.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: existing.id,
        },
      },
      data: updateData,
    });
  }

  /**
   * Deletes a contact strictly within tenant scope.
   */
  async deleteContact(tenantId: unknown, contactId: string): Promise<Contact> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findContactById(validTenantId, contactId);
    if (!existing) {
      throw new ContactNotFoundError();
    }

    return this.prisma.contact.delete({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: existing.id,
        },
      },
    });
  }

  /**
   * Counts contacts strictly scoped to the tenant.
   */
  async countContacts(tenantId: unknown): Promise<number> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.contact.count({
      where: { tenantId: validTenantId },
    });
  }

  // ==================== Tag Operations ====================

  /**
   * Creates a tag strictly scoped to the tenant.
   */
  async createTag(tenantId: unknown, input: CreateTagInput): Promise<Tag> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!input || !input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error('Tag name is required.');
    }

    return this.prisma.tag.create({
      data: {
        id: input.id,
        tenantId: validTenantId,
        name: input.name.trim(),
        color: input.color?.trim() ?? null,
        description: input.description?.trim() ?? null,
      },
    });
  }

  /**
   * Finds a tag by name within the tenant.
   */
  async findTagByName(tenantId: unknown, name: string): Promise<Tag | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return null;
    }

    return this.prisma.tag.findUnique({
      where: {
        tenantId_name: {
          tenantId: validTenantId,
          name: name.trim(),
        },
      },
    });
  }

  /**
   * Finds a tag by ID within the tenant.
   */
  async findTagById(tenantId: unknown, tagId: string): Promise<Tag | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!tagId || typeof tagId !== 'string' || tagId.trim().length === 0) {
      return null;
    }

    return this.prisma.tag.findFirst({
      where: {
        id: tagId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  /**
   * Lists tags for the tenant.
   */
  async listTags(tenantId: unknown): Promise<Tag[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.tag.findMany({
      where: { tenantId: validTenantId },
      orderBy: { name: 'asc' },
    });
  }

  // ==================== Contact-Tag Attachment ====================

  /**
   * Attaches a tag to a contact.
   * Strictly validates that BOTH contact and tag belong to the specified tenant scope.
   */
  async addTagToContact(
    tenantId: unknown,
    contactId: string,
    tagId: string,
  ): Promise<ContactTag> {
    const validTenantId = assertValidTenantId(tenantId);

    const contact = await this.findContactById(validTenantId, contactId);
    if (!contact) {
      throw new ContactNotFoundError(`Contact '${contactId}' not found within tenant scope.`);
    }

    const tag = await this.findTagById(validTenantId, tagId);
    if (!tag) {
      throw new TagNotFoundError(`Tag '${tagId}' not found within tenant scope.`);
    }

    return this.prisma.contactTag.create({
      data: {
        tenantId: validTenantId,
        contactId: contact.id,
        tagId: tag.id,
      },
    });
  }

  /**
   * Removes a tag from a contact within the tenant boundary.
   */
  async removeTagFromContact(
    tenantId: unknown,
    contactId: string,
    tagId: string,
  ): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await this.prisma.contactTag.deleteMany({
      where: {
        tenantId: validTenantId,
        contactId: contactId.trim(),
        tagId: tagId.trim(),
      },
    });
  }

  /**
   * Lists all tags associated with a specific contact within the tenant.
   */
  async listContactTags(tenantId: unknown, contactId: string): Promise<Tag[]> {
    const validTenantId = assertValidTenantId(tenantId);
    const contactTags = await this.prisma.contactTag.findMany({
      where: {
        tenantId: validTenantId,
        contactId: contactId.trim(),
      },
      include: {
        tag: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return contactTags.map((ct) => ct.tag);
  }

  // ==================== Suppression / Opt-out Operations ====================

  /**
   * Registers a phone number into the suppression (opt-out / blacklist) list.
   * If a contact with this phone exists in the same tenant, marks contact.isSuppressed = true.
   */
  async addSuppression(
    tenantId: unknown,
    input: AddSuppressionInput,
  ): Promise<SuppressionEntry> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!input || !input.phoneNormalized || typeof input.phoneNormalized !== 'string') {
      throw new Error('phoneNormalized is required for suppression.');
    }

    const phone = input.phoneNormalized.trim();
    if (phone.length === 0) {
      throw new Error('phoneNormalized cannot be empty.');
    }

    const entry = await this.prisma.suppressionEntry.upsert({
      where: {
        tenantId_phoneNormalized: {
          tenantId: validTenantId,
          phoneNormalized: phone,
        },
      },
      create: {
        id: input.id,
        tenantId: validTenantId,
        phoneNormalized: phone,
        reason: input.reason?.trim() ?? null,
        source: input.source?.trim() ?? null,
      },
      update: {
        reason: input.reason?.trim() ?? null,
        source: input.source?.trim() ?? null,
      },
    });

    // Keep contact status in sync within the same tenant
    await this.prisma.contact.updateMany({
      where: {
        tenantId: validTenantId,
        phoneNormalized: phone,
      },
      data: {
        isSuppressed: true,
      },
    });

    return entry;
  }

  /**
   * Checks if a phone number is suppressed in the given tenant.
   */
  async isSuppressed(tenantId: unknown, phoneNormalized: string): Promise<boolean> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!phoneNormalized || typeof phoneNormalized !== 'string' || phoneNormalized.trim().length === 0) {
      return false;
    }

    const found = await this.prisma.suppressionEntry.findUnique({
      where: {
        tenantId_phoneNormalized: {
          tenantId: validTenantId,
          phoneNormalized: phoneNormalized.trim(),
        },
      },
    });

    return found !== null;
  }

  /**
   * Removes a phone from suppression list for this tenant.
   * Also updates any existing contact in this tenant to isSuppressed = false.
   */
  async removeSuppression(tenantId: unknown, phoneNormalized: string): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!phoneNormalized || typeof phoneNormalized !== 'string' || phoneNormalized.trim().length === 0) {
      return;
    }

    const phone = phoneNormalized.trim();
    await this.prisma.suppressionEntry.deleteMany({
      where: {
        tenantId: validTenantId,
        phoneNormalized: phone,
      },
    });

    await this.prisma.contact.updateMany({
      where: {
        tenantId: validTenantId,
        phoneNormalized: phone,
      },
      data: {
        isSuppressed: false,
      },
    });
  }

  /**
   * Lists all suppression entries strictly within the tenant.
   */
  async listSuppressions(tenantId: unknown): Promise<SuppressionEntry[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.suppressionEntry.findMany({
      where: { tenantId: validTenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==================== Strict Tenant Cleanup (Never Global Wipe) ====================

  /**
   * Strictly cleans up contacts, tags, contact_tags, and suppression_entries
   * belonging exclusively to the specified tenant.
   */
  async clearTenant(tenantId: unknown): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await this.prisma.$transaction([
      this.prisma.contactTag.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.contact.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.tag.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.suppressionEntry.deleteMany({ where: { tenantId: validTenantId } }),
    ]);
  }
}
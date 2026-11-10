import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantContext } from '../tenant/tenant-context';
import {
  ContactsRepository,
  ContactNotFoundError,
  TagNotFoundError,
} from './contacts.repository';
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

@Injectable()
export class ContactsService {
  constructor(private readonly contactsRepository: ContactsRepository) {}

  // ==================== Contact Methods ====================

  async createContact(input: CreateContactInput): Promise<Contact> {
    const tenantId = TenantContext.getTenantId();
    try {
      return await this.contactsRepository.createContact(tenantId, input);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002' || /unique constraint/i.test((err as Error)?.message || '')) {
        throw new ConflictException('A contact with this phone number already exists in this tenant.');
      }
      throw err;
    }
  }

  async listContacts(options?: ListContactsOptions): Promise<Contact[]> {
    const tenantId = TenantContext.getTenantId();
    return this.contactsRepository.listContacts(tenantId, options);
  }

  async getContactById(contactId: string): Promise<Contact> {
    const tenantId = TenantContext.getTenantId();
    const contact = await this.contactsRepository.findContactById(tenantId, contactId);
    if (!contact) {
      throw new NotFoundException(`Contact '${contactId}' not found within tenant scope.`);
    }
    return contact;
  }

  async updateContact(contactId: string, input: UpdateContactInput): Promise<Contact> {
    const tenantId = TenantContext.getTenantId();
    try {
      return await this.contactsRepository.updateContact(tenantId, contactId, input);
    } catch (err: unknown) {
      if (err instanceof ContactNotFoundError) {
        throw new NotFoundException(err.message);
      }
      if ((err as { code?: string })?.code === 'P2002' || /unique constraint/i.test((err as Error)?.message || '')) {
        throw new ConflictException('A contact with this phone number already exists in this tenant.');
      }
      throw err;
    }
  }

  async deleteContact(contactId: string): Promise<Contact> {
    const tenantId = TenantContext.getTenantId();
    try {
      return await this.contactsRepository.deleteContact(tenantId, contactId);
    } catch (err: unknown) {
      if (err instanceof ContactNotFoundError) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  // ==================== Tag Methods ====================

  async createTag(input: CreateTagInput): Promise<Tag> {
    const tenantId = TenantContext.getTenantId();
    try {
      return await this.contactsRepository.createTag(tenantId, input);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002' || /unique constraint/i.test((err as Error)?.message || '')) {
        throw new ConflictException(`A tag with name '${input.name}' already exists in this tenant.`);
      }
      throw err;
    }
  }

  async listTags(): Promise<Tag[]> {
    const tenantId = TenantContext.getTenantId();
    return this.contactsRepository.listTags(tenantId);
  }

  async getTagById(tagId: string): Promise<Tag> {
    const tenantId = TenantContext.getTenantId();
    const tag = await this.contactsRepository.findTagById(tenantId, tagId);
    if (!tag) {
      throw new NotFoundException(`Tag '${tagId}' not found within tenant scope.`);
    }
    return tag;
  }

  // ==================== Contact Tags ====================

  async addTagToContact(contactId: string, tagId: string): Promise<ContactTag> {
    const tenantId = TenantContext.getTenantId();
    try {
      return await this.contactsRepository.addTagToContact(tenantId, contactId, tagId);
    } catch (err: unknown) {
      if (err instanceof ContactNotFoundError || err instanceof TagNotFoundError) {
        throw new NotFoundException(err.message);
      }
      if ((err as { code?: string })?.code === 'P2002' || /unique constraint/i.test((err as Error)?.message || '')) {
        // Already attached
        return (await this.contactsRepository.listContactTags(tenantId, contactId)) as unknown as ContactTag;
      }
      throw err;
    }
  }

  async removeTagFromContact(contactId: string, tagId: string): Promise<void> {
    const tenantId = TenantContext.getTenantId();
    await this.contactsRepository.removeTagFromContact(tenantId, contactId, tagId);
  }

  async listContactTags(contactId: string): Promise<Tag[]> {
    const tenantId = TenantContext.getTenantId();
    const contact = await this.contactsRepository.findContactById(tenantId, contactId);
    if (!contact) {
      throw new NotFoundException(`Contact '${contactId}' not found within tenant scope.`);
    }
    return this.contactsRepository.listContactTags(tenantId, contactId);
  }

  // ==================== Suppression Methods ====================

  async addSuppression(input: AddSuppressionInput): Promise<SuppressionEntry> {
    const tenantId = TenantContext.getTenantId();
    return this.contactsRepository.addSuppression(tenantId, input);
  }

  async isSuppressed(phoneNormalized: string): Promise<boolean> {
    const tenantId = TenantContext.getTenantId();
    return this.contactsRepository.isSuppressed(tenantId, phoneNormalized);
  }

  async removeSuppression(phoneNormalized: string): Promise<void> {
    const tenantId = TenantContext.getTenantId();
    await this.contactsRepository.removeSuppression(tenantId, phoneNormalized);
  }

  async listSuppressions(): Promise<SuppressionEntry[]> {
    const tenantId = TenantContext.getTenantId();
    return this.contactsRepository.listSuppressions(tenantId);
  }
}

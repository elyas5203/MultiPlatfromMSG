import { Contact, Tag, ContactTag, SuppressionEntry } from '@prisma/client';

export interface CreateContactInput {
  id?: string;
  phoneNormalized: string;
  phoneRaw?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown> | null;
  isSuppressed?: boolean;
}

export interface UpdateContactInput {
  phoneNormalized?: string;
  phoneRaw?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown> | null;
  isSuppressed?: boolean;
}

export interface ListContactsOptions {
  isSuppressed?: boolean;
  take?: number;
  skip?: number;
  tagId?: string;
  searchPhone?: string;
}

export interface CreateTagInput {
  id?: string;
  name: string;
  color?: string;
  description?: string;
}

export interface AddSuppressionInput {
  id?: string;
  phoneNormalized: string;
  reason?: string;
  source?: string;
}

export { Contact, Tag, ContactTag, SuppressionEntry };
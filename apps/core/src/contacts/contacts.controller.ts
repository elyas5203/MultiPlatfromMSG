import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantInterceptor } from '../tenant/tenant.interceptor';
import { RolesGuard } from '../rbac/roles.guard';
import { Roles } from '../rbac/roles.decorator';
import { Role } from '../rbac/roles.enum';
import { normalizeIranianMobile } from '../contacts-import/phone-normalizer';
import { ContactsService } from './contacts.service';
import {
  CreateContactDto,
  UpdateContactDto,
  ListContactsQueryDto,
  CreateTagDto,
  AddTagToContactDto,
  AddSuppressionDto,
} from './dto/contacts.dto';

@Controller('contacts')
@UseGuards(TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  // ==================== Tags ====================

  @Post('tags')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async createTag(@Body() body: unknown) {
    const input = CreateTagDto.parse(body);
    return this.contactsService.createTag(input);
  }

  @Get('tags')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listTags() {
    return this.contactsService.listTags();
  }

  @Get('tags/:id')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async getTagById(@Param('id') id: string) {
    return this.contactsService.getTagById(id);
  }

  // ==================== Suppressions (Opt-Out) ====================

  @Post('suppressions')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async addSuppression(@Body() body: unknown) {
    const input = AddSuppressionDto.parse(body);
    return this.contactsService.addSuppression(input);
  }

  @Get('suppressions')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listSuppressions() {
    return this.contactsService.listSuppressions();
  }

  @Get('suppressions/check')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async checkSuppressionByQuery(@Query('phone') phone: string | undefined) {
    if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
      throw new BadRequestException('phone query parameter is required for suppression check.');
    }
    const cleanPhone = phone.includes(' ') && !phone.includes('+') ? phone.replace(/ /g, '+') : phone;
    const norm = normalizeIranianMobile(cleanPhone);
    if (!norm.success) {
      throw new BadRequestException(`Invalid phone number: ${norm.message}`);
    }
    const isSuppressed = await this.contactsService.isSuppressed(norm.normalized);
    return {
      phoneNormalized: norm.normalized,
      isSuppressed,
    };
  }

  @Get('suppressions/:phone')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async checkSuppressionByParam(@Param('phone') phone: string) {
    const cleanPhone = phone.includes(' ') && !phone.includes('+') ? phone.replace(/ /g, '+') : phone;
    const norm = normalizeIranianMobile(cleanPhone);
    if (!norm.success) {
      throw new BadRequestException(`Invalid phone number: ${norm.message}`);
    }
    const isSuppressed = await this.contactsService.isSuppressed(norm.normalized);
    return {
      phoneNormalized: norm.normalized,
      isSuppressed,
    };
  }

  @Delete('suppressions/:phone')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP)
  async removeSuppression(@Param('phone') phone: string) {
    const cleanPhone = phone.includes(' ') && !phone.includes('+') ? phone.replace(/ /g, '+') : phone;
    const norm = normalizeIranianMobile(cleanPhone);
    if (!norm.success) {
      throw new BadRequestException(`Invalid phone number: ${norm.message}`);
    }
    await this.contactsService.removeSuppression(norm.normalized);
    return {
      success: true,
      phoneNormalized: norm.normalized,
    };
  }

  // ==================== Contact CRUD ====================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async createContact(@Body() body: unknown) {
    const input = CreateContactDto.parse(body);
    return this.contactsService.createContact(input);
  }

  @Get()
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listContacts(@Query() query: Record<string, string | undefined>) {
    const options = ListContactsQueryDto.parse(query);
    return this.contactsService.listContacts(options);
  }

  @Get(':id')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async getContactById(@Param('id') id: string) {
    return this.contactsService.getContactById(id);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP)
  async updateContactPut(@Param('id') id: string, @Body() body: unknown) {
    const input = UpdateContactDto.parse(body);
    return this.contactsService.updateContact(id, input);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP)
  async updateContactPatch(@Param('id') id: string, @Body() body: unknown) {
    const input = UpdateContactDto.parse(body);
    return this.contactsService.updateContact(id, input);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP)
  async deleteContact(@Param('id') id: string) {
    const deleted = await this.contactsService.deleteContact(id);
    return {
      success: true,
      deleted,
    };
  }

  // ==================== Contact Tags ====================

  @Post(':id/tags')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async addTagFromBody(
    @Param('id') contactId: string,
    @Body() body: unknown,
  ) {
    const { tagId } = AddTagToContactDto.parse(body);
    return this.contactsService.addTagToContact(contactId, tagId);
  }

  @Post(':id/tags/:tagId')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async addTagFromParam(
    @Param('id') contactId: string,
    @Param('tagId') tagId: string,
  ) {
    return this.contactsService.addTagToContact(contactId, tagId);
  }

  @Delete(':id/tags/:tagId')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP)
  async removeTag(
    @Param('id') contactId: string,
    @Param('tagId') tagId: string,
  ) {
    await this.contactsService.removeTagFromContact(contactId, tagId);
    return { success: true };
  }

  @Get(':id/tags')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listContactTags(@Param('id') contactId: string) {
    return this.contactsService.listContactTags(contactId);
  }
}

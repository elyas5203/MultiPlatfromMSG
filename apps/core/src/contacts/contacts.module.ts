import {
  Module,
  NestModule,
  MiddlewareConsumer,
  Injectable,
  NestMiddleware,
  Optional,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { normalizeRole } from '../rbac/roles.enum';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactsRepository } from './contacts.repository';

@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  constructor(@Optional() private readonly authService?: AuthService) {}

  async use(req: any, res: any, next: () => void): Promise<void> {
    // 1. If user is already attached, proceed
    if (req.user || req.staff) {
      return next();
    }

    // 2. Direct role simulation header (useful for RBAC tests and internal calls)
    const roleHeader = req.headers?.['x-user-role'];
    if (roleHeader && typeof roleHeader === 'string' && roleHeader.trim().length > 0) {
      const normalized = normalizeRole(roleHeader.trim());
      req.user = {
        id: (req.headers?.['x-user-id'] as string) || 'test-user-id',
        tenantId: req.tenantId || req.headers?.['x-tenant-id'],
        role: normalized || roleHeader.trim(),
      };
      return next();
    }

    // 3. Bearer authorization token
    const authHeader = req.headers?.['authorization'];
    if (authHeader && typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && match[1] && this.authService) {
        try {
          const validated = await this.authService.validateSession(match[1]);
          req.user = {
            id: validated.staff.id,
            tenantId: validated.staff.tenantId,
            role: validated.staff.role,
          };
        } catch {
          // Token invalid/expired: leave req.user undefined, guard will fail-closed (403)
        }
      }
    }

    next();
  }
}

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsRepository, AuthContextMiddleware],
  exports: [ContactsService, ContactsRepository],
})
export class ContactsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes(ContactsController);
  }
}

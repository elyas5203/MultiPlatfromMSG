import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to explicitly mark route handlers or controllers as publicly accessible,
 * exempting them from mandatory tenant context requirements (e.g. login).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function bootstrap(): Promise<void> {
  // Local application context without public endpoints or send pipelines
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  // Standalone core skeleton context initialized successfully
  await appContext.close();
}

if (require.main === module) {
  bootstrap().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to bootstrap Core application context:', err);
    process.exit(1);
  });
}

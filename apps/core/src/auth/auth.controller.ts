import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { AuthService, LoginResult } from './auth.service';

export interface LoginDto {
  tenantId: string;
  username: string;
  password: string;
}

export interface ChangePasswordDto {
  token?: string;
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordDto {
  token?: string;
  tenantId: string;
  staffId: string;
  newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private extractBearerToken(authHeader?: string, bodyToken?: string): string {
    if (authHeader && authHeader.trim().length > 0) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    if (bodyToken && typeof bodyToken === 'string' && bodyToken.trim().length > 0) {
      return bodyToken.trim();
    }
    throw new BadRequestException('Authorization bearer token is missing');
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto): Promise<LoginResult> {
    return this.authService.login(body.tenantId, body.username, body.password);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Headers('authorization') authHeader?: string,
    @Body('token') bodyToken?: string,
  ): Promise<{ success: boolean; message: string }> {
    let token = '';
    try {
      token = this.extractBearerToken(authHeader, bodyToken);
    } catch {
      return { success: true, message: 'Logged out successfully' };
    }
    return this.authService.logout(token);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean; message: string }> {
    const token = this.extractBearerToken(authHeader, body.token);
    return this.authService.changePassword(token, body.currentPassword, body.newPassword);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: ResetPasswordDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean; message: string }> {
    const token = this.extractBearerToken(authHeader, body.token);
    return this.authService.resetPassword(
      token,
      body.tenantId,
      body.staffId,
      body.newPassword,
    );
  }
}

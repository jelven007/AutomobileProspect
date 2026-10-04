import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  OnModuleInit,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';

export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

export interface AuthUser {
  sub: string;
  roles: string[];
}

@Injectable()
export class AuthGuard implements CanActivate, OnModuleInit {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  onModuleInit(): void {
    if (process.env.AUTH_DISABLED !== 'true' && !process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is required unless AUTH_DISABLED=true');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>('public', [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthUser;
    }>();

    if (process.env.AUTH_DISABLED === 'true') {
      request.user = { sub: 'local-development', roles: ['admin', 'operator', 'viewer'] };
      return true;
    }

    const authorization = request.headers.authorization;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 40101, message: 'missing_bearer_token' });
    }

    try {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET as string);
      const verified = await jwtVerify(header.slice(7), secret, {
        issuer: process.env.JWT_ISSUER || undefined,
        audience: process.env.JWT_AUDIENCE || undefined,
      });
      const rawRoles = verified.payload.roles ?? verified.payload.role;
      const roles = Array.isArray(rawRoles)
        ? rawRoles.filter((role): role is string => typeof role === 'string')
        : typeof rawRoles === 'string'
          ? [rawRoles]
          : [];
      request.user = {
        sub: verified.payload.sub ?? 'unknown',
        roles,
      };
    } catch {
      throw new UnauthorizedException({ code: 40102, message: 'invalid_bearer_token' });
    }

    const required = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    if (required.length > 0 && !required.some((role) => request.user?.roles.includes(role))) {
      throw new ForbiddenException({ code: 40301, message: 'insufficient_role' });
    }
    return true;
  }
}

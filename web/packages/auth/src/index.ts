export interface AuthUser {
  userId: string;
  name: string;
  roles: string[];
  tenantId: string;
}

export function parseToken(token: string): AuthUser | null {
  if (!token) return null;
  // TODO: 对接 OIDC / 内部 SSO
  return { userId: 'u_demo', name: 'demo', roles: ['sales'], tenantId: 't_default' };
}

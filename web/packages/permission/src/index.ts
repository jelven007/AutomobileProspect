export type Role = 'admin' | 'marketing' | 'sales' | 'ops' | 'viewer';

const RULES: Record<Role, string[]> = {
  admin: ['*'],
  marketing: ['segment.*', 'journey.*', 'experiment.*', 'profile.read'],
  sales: ['lead.*', 'profile.read'],
  ops: ['tag.*', 'quality.*'],
  viewer: ['*.read'],
};

export function can(roles: Role[], perm: string): boolean {
  return roles.some((r) =>
    (RULES[r] ?? []).some((rule) => rule === '*' || rule === perm || rule.endsWith('.*') && perm.startsWith(rule.slice(0, -1))),
  );
}

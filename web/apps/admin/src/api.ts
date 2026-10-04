import { LeadOpsClient } from '@leadops/api-client';

export const api = new LeadOpsClient({
  baseUrl: import.meta.env.VITE_BFF_URL ?? '/bff/',
  getToken: () => (
    import.meta.env.VITE_AUTH_TOKEN
    ?? window.localStorage.getItem('leadops_access_token')
    ?? undefined
  ),
});

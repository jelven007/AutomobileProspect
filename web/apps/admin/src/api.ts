import { LeadOpsClient } from '@leadops/api-client';

export const api = new LeadOpsClient({
  baseUrl: import.meta.env.VITE_BFF_URL ?? 'http://localhost:7001/bff/',
});

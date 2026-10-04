import ky, { type KyInstance } from 'ky';
import type {
  ApiEnvelope,
  Profile,
  Segment,
  SegmentExpr,
  Lead,
  OneId,
  Customer,
  CustomerListQuery,
  CustomerListResult,
  CustomerFacets,
  CustomerImportReport,
  IngestJob,
} from '@leadops/types';

export interface ClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined;
}

export class LeadOpsClient {
  private http: KyInstance;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.http = ky.create({
      prefixUrl: opts.baseUrl,
      timeout: 30_000,
      retry: { limit: 2 },
      hooks: {
        beforeRequest: [
          (request) => {
            const token = opts.getToken?.();
            if (token) request.headers.set('Authorization', `Bearer ${token}`);
            request.headers.set('X-Request-Id', crypto.randomUUID());
          },
        ],
      },
    });
  }

  private async unwrap<T>(p: Promise<Response>): Promise<T> {
    const res = await p;
    const body = (await res.json()) as ApiEnvelope<T>;
    if (body.code !== 0) throw new Error(`[${body.code}] ${body.message}`);
    return body.data;
  }

  profile = {
    get: (oneid: OneId) => this.unwrap<Profile>(this.http.get(`v1/profile/${oneid}`)),
    batch: (oneids: OneId[], fields?: string) =>
      this.unwrap<{ profiles: Profile[] }>(
        this.http.post('v1/profile/batch', { json: { oneids, fields } }),
      ),
  };

  segment = {
    estimate: (expression: SegmentExpr) =>
      this.unwrap<{ estimated_count: number; elapsed_ms: number }>(
        this.http.post('v1/segment/estimate', { json: { expression } }),
      ),
    create: (name: string, expression: SegmentExpr, owner: string) =>
      this.unwrap<Segment>(
        this.http.post('v1/segment', { json: { name, expression, owner } }),
      ),
    get: (id: string) => this.unwrap<Segment>(this.http.get(`v1/segment/${id}`)),
  };

  sdr = {
    myLeads: (sales_id: string, limit = 20) =>
      this.unwrap<{ leads: Lead[] }>(
        this.http.get('v1/sdr/leads', { searchParams: { sales_id, limit } }),
      ),
    followup: (lead_id: string, payload: { status: string; note?: string; next_contact_at?: string }) =>
      this.unwrap<null>(this.http.post(`v1/sdr/leads/${lead_id}/followup`, { json: payload })),
  };

  customer = {
    list: (q: CustomerListQuery = {}) =>
      this.unwrap<CustomerListResult>(
        this.http.get('customer', { searchParams: q as Record<string, string | number> }),
      ),
    facets: () => this.unwrap<CustomerFacets>(this.http.get('customer/facets')),
    detail: (id: string) => this.unwrap<Customer>(this.http.get(`customer/${id}`)),
    create: (dto: Partial<Customer>) => this.unwrap<Customer>(this.http.post('customer', { json: dto })),
    update: (id: string, dto: Partial<Customer> & { version: number }) =>
      this.unwrap<Customer>(this.http.put(`customer/${id}`, { json: dto })),
    remove: (id: string) => this.unwrap<{ ok: boolean }>(this.http.delete(`customer/${id}`)),
    batchDelete: (ids: string[]) =>
      this.unwrap<{ deleted: number }>(this.http.post('customer/batch-delete', { json: { ids } })),
    removeAll: () => this.unwrap<{ deleted: number }>(this.http.delete('customer/_all')),
    export: async (q: CustomerListQuery = {}): Promise<{ blob: Blob; filename: string; groups: number; total: number }> => {
      const url = new URL('customer/export', this.opts.baseUrl);
      for (const [k, v] of Object.entries(q)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
      const token = this.opts.getToken?.();
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Request-Id': crypto.randomUUID(),
        },
      });
      if (!res.ok) throw new Error(`[${res.status}] ${await res.text()}`);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? `customers-export-${Date.now()}.zip`;
      const groups = Number(res.headers.get('X-Export-Groups') ?? 0);
      const total = Number(res.headers.get('X-Export-Total') ?? 0);
      const blob = await res.blob();
      return { blob, filename, groups, total };
    },
    import: (file: File, onProgress?: (loaded: number, total: number) => void) =>
      new Promise<CustomerImportReport>((resolve, reject) => {
        const form = new FormData();
        form.append('file', file, file.name);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', new URL('customer/import', this.opts.baseUrl).toString());
        const token = this.opts.getToken?.();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (onProgress) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          try {
            const body = JSON.parse(xhr.responseText) as ApiEnvelope<CustomerImportReport>;
            if (body.code === 0) resolve(body.data);
            else reject(new Error(`[${body.code}] ${body.message}`));
          } catch (e) {
            reject(e as Error);
          }
        };
        xhr.onerror = () => reject(new Error('network_error'));
        xhr.send(form);
      }),
  };

  ingestJobs = {
    list: () => this.unwrap<IngestJob[]>(this.http.get('ingest-jobs')),
    retry: (jobId: string) => this.unwrap<{ ok: boolean }>(this.http.post(`ingest-jobs/${jobId}/retry`)),
  };
}

export * from '@leadops/types';

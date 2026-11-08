// Thin fetch wrapper for the CMDB API (cookie session + CSRF header)

let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path?: string; message: string }[],
  ) {
    super(message);
  }
}

export type QueryValue = string | number | boolean | null | undefined | string[];
export type Query = Record<string, QueryValue>;

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) params.set(k, v.join(','));
    } else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  formData?: FormData;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.formData) body = opts.formData;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message = isJson && data?.error ? data.error : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, isJson && Array.isArray(data?.details) ? data.details : undefined);
  }
  return data as T;
}

export const http = {
  get: <T>(path: string, query?: Query) => api<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body }),
  del: <T = void>(path: string) => api<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, file: File | Blob, query?: Query, method = 'POST') => {
    const fd = new FormData();
    fd.append('file', file);
    return api<T>(path, { method, formData: fd, query });
  },
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details?.length) return `${err.message}: ${err.details.map((d) => (d.path ? `${d.path} – ${d.message}` : d.message)).join('; ')}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

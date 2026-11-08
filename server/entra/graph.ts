/**
 * Minimal read-only Microsoft Graph client (v1.0) for the app-only token.
 * - follows @odata.nextLink only within graph.microsoft.com (no SSRF via continuation tokens)
 * - retries 429/503/504 and honours Retry-After (capped)
 */

export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 10_000;

export class GraphClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Absolute Graph URL for a path such as "/users?$top=10"; continuation links must point to Graph v1.0. */
  static url(pathOrUrl: string): string {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`;
    if (!url.startsWith(`${GRAPH_ROOT}/`)) throw new GraphError('Unexpected Microsoft Graph URL', 400, 'invalidUrl');
    return url;
  }

  async get<T>(pathOrUrl: string, opts: { eventual?: boolean } = {}): Promise<T> {
    const url = GraphClient.url(pathOrUrl);
    for (let attempt = 1; ; attempt++) {
      const token = await this.token();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (opts.eventual) headers.ConsistencyLevel = 'eventual';
      const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await this.sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new GraphError(body?.error?.message ?? `Microsoft Graph returned HTTP ${res.status}`, res.status, body?.error?.code ?? null);
      }
      return (await res.json()) as T;
    }
  }

  /** All items of a collection, following nextLink (bounded). */
  async all<T>(path: string, opts: { eventual?: boolean; maxPages?: number } = {}): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < (opts.maxPages ?? 20); page++) {
      const res: GraphPage<T> = await this.get<GraphPage<T>>(next, opts);
      items.push(...res.value);
      next = res['@odata.nextLink'];
    }
    return items;
  }
}

/** Continuation token handed to the browser: the Graph nextLink, base64url encoded (validated again when used). */
export const encodeNext = (nextLink: string | undefined): string | null => (nextLink ? Buffer.from(nextLink, 'utf8').toString('base64url') : null);
export const decodeNext = (token: string): string => GraphClient.url(Buffer.from(token, 'base64url').toString('utf8'));

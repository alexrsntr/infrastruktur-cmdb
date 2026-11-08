import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../lib/log';

/**
 * Where attachment files live. Metadata always stays in PostgreSQL (table `attachment`);
 * only the bytes go through this interface, addressed by the attachment's `storage_key`.
 */
export interface FileStorage {
  readonly driver: Config['storage']['driver'];
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(keys: string[]): Promise<void>;
}

/** Development / tests / small installations: file contents in table file_blob */
class DatabaseStorage implements FileStorage {
  readonly driver = 'database' as const;
  constructor(private pool: Pool) {}

  async put(key: string, data: Buffer): Promise<void> {
    await this.pool.query('INSERT INTO file_blob (storage_key, data) VALUES ($1, $2)', [key, data]);
  }

  async get(key: string): Promise<Buffer> {
    const { rows } = await this.pool.query<{ data: Buffer }>('SELECT data FROM file_blob WHERE storage_key = $1', [key]);
    if (!rows[0]) throw new StorageNotFoundError(key);
    return rows[0].data;
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.pool.query('DELETE FROM file_blob WHERE storage_key = ANY($1::text[])', [keys]);
  }
}

/** Production: Azure Blob Storage, authenticated with the app's managed identity (or a connection string for Azurite) */
class AzureBlobStorage implements FileStorage {
  readonly driver = 'azure-blob' as const;
  private container: ContainerClient;
  private ensured: Promise<void> | null = null;

  constructor(config: Config) {
    const { accountUrl, connectionString, container } = config.storage;
    let service: BlobServiceClient;
    if (connectionString) {
      service = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      const mi = config.managedIdentityClientId || undefined;
      const credential: TokenCredential =
        process.env.WEBSITE_INSTANCE_ID || process.env.IDENTITY_ENDPOINT
          ? new ManagedIdentityCredential(mi ? { clientId: mi } : undefined)
          : new DefaultAzureCredential(mi ? { managedIdentityClientId: mi } : undefined);
      service = new BlobServiceClient(accountUrl, credential);
    }
    this.container = service.getContainerClient(container);
  }

  /** Creates the container on first use (Terraform creates it in Azure; this helps with Azurite / new accounts). */
  private ensureContainer(): Promise<void> {
    if (!this.ensured) {
      this.ensured = this.container
        .createIfNotExists()
        .then(() => undefined)
        .catch((err: Error & { statusCode?: number }) => {
          // 403 = identity may write blobs but not manage containers – fine if the container exists
          if (err.statusCode !== 403) {
            this.ensured = null;
            throw err;
          }
        });
    }
    return this.ensured;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.ensureContainer();
    await this.container.getBlockBlobClient(key).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await this.container.getBlobClient(key).downloadToBuffer();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) await this.container.getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include' });
  }
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`File not found in storage: ${key}`);
  }
}

export function createStorage(pool: Pool, config: Config): FileStorage {
  const storage = config.storage.driver === 'azure-blob' ? new AzureBlobStorage(config) : new DatabaseStorage(pool);
  log.info(`storage: using ${storage.driver} driver for attachments`, config.storage.driver === 'azure-blob' ? { container: config.storage.container } : undefined);
  return storage;
}

/** Sanitises a user supplied file name for storage keys and downloads. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

/** Storage key: <plant id or "global">/<uuid>/<file name> */
export function storageKey(plantId: string | null, id: string, fileName: string): string {
  const safe = sanitizeFileName(fileName).replace(/[^\w.()-]/g, '_');
  return `${plantId ?? 'global'}/${id}/${safe}`;
}

/**
 * R2 storage for uploads (port of backend/storage/r2.go).
 *
 * Why presigned PUT instead of piping the file through the Function:
 *  - the browser uploads straight to R2, so the bytes never count against the
 *    Function's request-body limit (100 MB on the free plan; video uploads go up
 *    to 500 MB) nor its CPU time, and it costs one Function call either way;
 *  - the API contract (presign → PUT putUrl → confirm) stays identical to Go.
 * The R2 *binding* cannot sign URLs, so signing uses the S3-compatible API via
 * aws4fetch (an R2 API token: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY). head()
 * and delete() on confirm go through the binding (no extra credentials, no
 * egress, and they are cheap Class B / free operations).
 */
import { AwsClient } from 'aws4fetch';
import type { UploadStorage } from './services';
import type { HubEnv, R2Bucket } from './types';

export interface R2StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
  binding: R2Bucket;
}

/** Encode each key segment for the S3 path (keys we mint only contain [a-z0-9_-./]). */
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export class R2Storage implements UploadStorage {
  private readonly aws: AwsClient;
  constructor(private readonly cfg: R2StorageConfig) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' });
  }

  /**
   * Presigned PUT (path-style, like Go UsePathStyle). Content-Type is a signed
   * header, same as the Go presigner with ContentType set, so the browser must
   * send exactly that Content-Type (services/uploadApi.ts does).
   */
  async presignPut(key: string, contentType: string, ttlSec: number): Promise<string> {
    const url = new URL(`https://${this.cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(this.cfg.bucket)}/${encodeKey(key)}`);
    url.searchParams.set('X-Amz-Expires', String(ttlSec));
    const signed = await this.aws.sign(new Request(url, { method: 'PUT', headers: { 'content-type': contentType } }), {
      aws: { signQuery: true, allHeaders: true },
    });
    return signed.url;
  }

  publicUrl(key: string): string {
    if (!this.cfg.publicBase) return '';
    return `${this.cfg.publicBase.replace(/\/+$/, '')}/${key}`;
  }

  async head(key: string) {
    const obj = await this.cfg.binding.head(key);
    if (!obj) return null;
    return { size: obj.size, contentType: obj.httpMetadata?.contentType ?? '' };
  }

  async delete(key: string) {
    await this.cfg.binding.delete(key);
  }
}

/** Storage is optional (Go StorageReady): null when any piece is missing → upload routes answer 503 存储未配置. */
export function storageFromEnv(env: HubEnv): R2Storage | null {
  if (!env.HUB_BUCKET || !env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  return new R2Storage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBase: env.R2_PUBLIC_BASE ?? '',
    binding: env.HUB_BUCKET,
  });
}

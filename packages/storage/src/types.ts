export type UploadOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
};

export type UploadResult = {
  etag: string;
  size?: number;
};

export type DirectUploadInput = {
  key: string;
  contentType: string;
  maxSizeBytes?: number;
  expiresIn?: number; // seconds, max 3600
};

export type DirectUploadCapability = {
  key: string;
  contentType: string;
  maxSizeBytes?: number;
  expiresAt: number; // unix timestamp ms
};

export interface StorageProvider {
  upload(key: string, body: Uint8Array | ArrayBuffer, opts?: UploadOptions): Promise<UploadResult>;
  download(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  generatePresignedDownloadUrl(key: string, opts?: { expiresIn?: number }): Promise<string>;
  generateDirectUploadCapability(input: DirectUploadInput): Promise<string>;
  verifyDirectUploadCapability(token: string): Promise<DirectUploadCapability | null>;
}

export type VirusScanHook = (key: string, body: Uint8Array | ArrayBuffer) => Promise<void>;
// Should throw if infected. Default is a no-op.

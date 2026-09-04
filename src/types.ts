/// <reference path="/usr/lib/node_modules/openclaw/node_modules/@types/node/index.d.ts" />

export interface ShareRecord {
  code: string;
  file_path: string; // Absolute canonical path
  rel_path: string;  // Relative to AllowedRoot
  filename: string;
  created_at: string; // ISO 8601 string
  expires_at: string; // ISO 8601 string
  max_downloads: number; // 0 = unlimited
  download_count: number;
  inline: boolean;
  revoked: boolean;
}

export interface UploadFileRecord {
  filename: string;
  size: number;
  uploaded_at: string; // ISO 8601 string
  rel_path: string;
}

export interface UploadChannel {
  code: string;
  target_dir: string; // Absolute canonical path
  rel_dir: string;    // Relative to AllowedRoot
  created_at: string; // ISO 8601 string
  expires_at: string; // ISO 8601 string
  max_uploads: number; // 0 = unlimited
  upload_count: number;
  revoked: boolean;
  files: UploadFileRecord[];
}

export interface FileserverConfig {
  bind_addr: string;
  base_url: string;
  upload_base_url: string;
  upload_dir: string;
  secret_key: string;
  allowed_root: string;
  default_ttl: string;
  max_ttl: string;
  api_token: string;
  data_file: string;
  upload_data_file: string;
  max_upload_bytes: number;
}

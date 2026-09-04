export interface ShareRecord {
    code: string;
    file_path: string;
    rel_path: string;
    filename: string;
    created_at: string;
    expires_at: string;
    max_downloads: number;
    download_count: number;
    inline: boolean;
    revoked: boolean;
}
export interface UploadFileRecord {
    filename: string;
    size: number;
    uploaded_at: string;
    rel_path: string;
}
export interface UploadChannel {
    code: string;
    target_dir: string;
    rel_dir: string;
    created_at: string;
    expires_at: string;
    max_uploads: number;
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

export interface CustomerRow {
  name: string;
  huji_no?: string;
  stat_time?: string | null;
  birth_date?: string | null;
  gender?: 'M' | 'F' | 'U';
  id_type?: string;
  id_card?: string;
  phone_masked?: string;
  address?: string;
  province?: string;
  city?: string;
  district?: string;
  occupation?: string;
  education?: string;
  marital_status?: string;
  source_file: string;
  source_row: number;
  ingest_batch: string;
}

export interface SchemaColumn {
  index: number;
  field: keyof CustomerRow;
  required?: boolean;
  transform?: string;
  transform_args?: unknown[];
}

export interface DedupeConfig {
  key: keyof CustomerRow;
  keep?: 'first' | 'last';
  cross_batch?: {
    on_conflict: 'update' | 'skip' | 'fail';
    bump_version?: boolean;
  };
  secondary_key_warn?: keyof CustomerRow;
}

export interface IngestSchema {
  source: {
    /**
     * 存储类型。全部走 S3 兼容协议：
     * - s3   : AWS S3 原生
     * - tos  : 火山引擎对象存储（S3 兼容入口）
     * - oss  : 阿里云 OSS（S3 兼容入口）
     * - minio: 自建 MinIO
     * 不同 type 共用同一个 S3Client，区分仅用于日志标注与默认 forcePathStyle 推断。
     */
    type: 's3' | 'tos' | 'oss' | 'minio';
    bucket: string;
    prefix: string;
    /** S3 兼容 endpoint，如 https://tos-s3-cn-beijing.volces.com */
    endpoint?: string;
    /** 区域码，如 cn-beijing。未填时读 AWS_REGION / 默认 us-east-1 */
    region?: string;
    /** 自建 / 非 AWS 对象存储通常需要 true；未显式配置时按 type 推断 */
    force_path_style?: boolean;
  };
  parse: {
    skip_header_rows: number;
    sheet: number;
  };
  columns: {
    drop_indexes: number[];
    mappings: SchemaColumn[];
  };
  dedupe?: DedupeConfig;
  sink: {
    type: 'postgres';
    table: string;
    batch_size: number;
    conflict_key: string;
  };
}

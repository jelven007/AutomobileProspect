export type OneId = string;

export type IntentLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface UserBasic {
  oneid: OneId;
  age_range?: string;
  city?: string;
  city_tier?: '一线' | '新一线' | '二线' | '三线及以下';
  gender?: 'M' | 'F' | 'U';
  occupation?: string;
}

export interface UserTag {
  tag_id: number;
  name: string;
  value: string | number | boolean;
  updated_at: string;
}

export interface UserScore {
  intent_score: number;
  intent_level: IntentLevel;
  churn_risk?: number;
  price_band?: string;
}

export interface UserBehavior {
  ts: string;
  event: string;
  value?: string;
  properties?: Record<string, unknown>;
}

export interface Profile {
  basic: UserBasic;
  tags: UserTag[];
  score: UserScore;
  behavior_recent?: UserBehavior[];
}

export type SegmentOperator = 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';

export type SegmentExpr =
  | { op: 'AND'; children: SegmentExpr[] }
  | { op: 'OR'; children: SegmentExpr[] }
  | { op: 'NOT'; child: SegmentExpr }
  | {
      tag_id: number;
      op: SegmentOperator;
      value: unknown;
      time_window?: string;
    };

export interface Segment {
  segment_id: string;
  name: string;
  owner: string;
  expression: SegmentExpr;
  status: 'running' | 'ready' | 'failed';
  estimated_count?: number;
  final_count?: number;
  created_at: string;
}

export interface Lead {
  lead_id: string;
  oneid: OneId;
  intent_level: IntentLevel;
  intent_score: number;
  preferred_models: string[];
  city: string;
  assigned_at: string;
  deadline: string;
  recommended_script?: string;
}

export type MessageChannel = 'sms' | 'wecom' | 'call' | 'push' | 'email' | 'ad';

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export interface Customer {
  customer_id: string;
  huji_no?: string;
  name: string;
  gender?: 'M' | 'F' | 'U';
  birth_date?: string;
  id_card?: string;
  phone_masked?: string;
  address?: string;
  stat_time?: string;
  province?: string;
  city?: string;
  district?: string;
  occupation?: string;
  education?: string;
  marital_status?: string;
  source_file?: string;
  source_row?: number;
  ingest_batch?: string;
  version: number;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerListQuery {
  q?: string;
  address?: string;
  province?: string;
  city?: string;
  district?: string;
  gender?: 'M' | 'F' | 'U';
  cursor?: string;
  limit?: number;
}

export interface CustomerFacets {
  province: string[];
  city: string[];
  district: string[];
}

export interface CustomerListResult {
  items: Customer[];
  next_cursor?: string;
  has_more: boolean;
  total: number;
}

export interface IngestJob {
  job_id: string;
  source_bucket?: string;
  source_prefix?: string;
  file_name?: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  total_rows: number;
  success_rows: number;
  skipped_rows: number;
  duplicate_rows: number;
  written_rows: number;
  inserted_rows: number;
  updated_rows: number;
  checkpoint_row: number;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

export interface ExportJob {
  job_id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  file_name?: string;
  total_rows: number;
  groups: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  expires_at?: string;
  error?: string;
}

export interface CustomerImportReport {
  job_id: string;
  file_name: string;
  total_rows: number;
  success_rows: number;    // 清洗通过（去重前）
  skipped_rows: number;    // 清洗失败
  duplicate_rows: number;  // 文件内身份证重复，被合并
  written_rows: number;    // 实际入库（含 insert + update）
  inserted_rows: number;   // 新增（本次导入前库内无匹配）
  updated_rows: number;    // 合并到已有记录（跨批次 UPSERT）
  conflict_warnings: Array<{ huji_no: string; against: string; reason: string }>;
  errors: Array<{ row: number; reason: string }>;
  elapsed_ms: number;
  /** 清洗阶段非致命告警计数（如 id_card_district_unknown） */
  warnings_summary?: Record<string, number>;
  /** 本次导入基于表头动态识别到的列映射，便于前端复核"系统是否正确识别到手机号/地址/身份证" */
  detected_mapping?: Array<{ index: number; header: string; field: string }>;
}

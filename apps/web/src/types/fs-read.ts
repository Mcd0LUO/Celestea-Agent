// types/fs-read.ts — F2 P1：GET /api/fs/read 的冻结线格式（工作区文件内容读取）。
export interface FsReadResp {
  path: string;
  size: number;
  kind: 'text' | 'binary';
  text: string;
  offset: number;
  limit: number;
  totalLines: number;
  truncated: boolean;
  /** 4xx 时的可读原因（200 正常响应不带）。 */
  error?: string;
}

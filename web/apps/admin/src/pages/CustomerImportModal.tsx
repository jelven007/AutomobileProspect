import { useState } from 'react';
import { Alert, App, Button, Modal, Progress, Table, Typography, Upload } from 'antd';
import { CheckCircleFilled, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import type { CustomerImportReport } from '@leadops/types';
import { api } from '../api';

const { Dragger } = Upload;
const { Paragraph, Text } = Typography;
const MAX_IMPORT_FILES = 30;

interface BatchImportResult {
  uid: string;
  fileName: string;
  status: 'success' | 'failed';
  report?: CustomerImportReport;
  error?: string;
}

function formatImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('xlsx_archive_corrupted')) {
    return 'Excel 文件压缩数据已损坏，请重新获取原文件，或用 Excel 打开后另存为新的 .xlsx 文件';
  }
  if (message.includes('xlsx_worksheet_missing')) {
    return 'Excel 文件中未找到可导入的工作表';
  }
  return message;
}

export function CustomerImportModal({
  open,
  onCancel,
  onImported,
}: {
  open: boolean;
  onCancel: () => void;
  onImported: () => void;
}) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [currentFileIndex, setCurrentFileIndex] = useState(-1);
  const [results, setResults] = useState<BatchImportResult[]>([]);
  const [report, setReport] = useState<CustomerImportReport | null>(null);
  const { message, notification } = App.useApp();

  const reset = () => {
    setFiles([]);
    setUploading(false);
    setPercent(0);
    setCurrentFileIndex(-1);
    setResults([]);
    setReport(null);
  };

  const handleUpload = async () => {
    const selectedFiles = files.flatMap((item) => (
      item.originFileObj ? [item.originFileObj as File] : []
    ));
    if (selectedFiles.length === 0) return;
    setUploading(true);
    setPercent(0);
    setCurrentFileIndex(0);
    setResults([]);
    setReport(null);
    const nextResults: BatchImportResult[] = [];
    let firstSuccessfulReport: CustomerImportReport | null = null;

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      setCurrentFileIndex(index);
      try {
        const nextReport = await api.customer.import(file, (loaded, total) => {
          const fileProgress = total ? loaded / total : 0;
          setPercent(Math.round(((index + fileProgress) / selectedFiles.length) * 100));
        });
        const result: BatchImportResult = {
          uid: files[index]?.uid ?? `${index}`,
          fileName: file.name,
          status: 'success',
          report: nextReport,
        };
        nextResults.push(result);
        if (!firstSuccessfulReport) firstSuccessfulReport = nextReport;
      } catch (error) {
        nextResults.push({
          uid: files[index]?.uid ?? `${index}`,
          fileName: file.name,
          status: 'failed',
          error: formatImportError(error),
        });
      }
      setResults([...nextResults]);
      setPercent(Math.round(((index + 1) / selectedFiles.length) * 100));
    }

    const successCount = nextResults.filter((item) => item.status === 'success').length;
    const failedCount = nextResults.length - successCount;
    setReport(firstSuccessfulReport);
    setUploading(false);
    setCurrentFileIndex(-1);
    if (successCount > 0) onImported();

    const description = `成功 ${successCount} 个，失败 ${failedCount} 个，共 ${nextResults.length} 个文件`;
    if (failedCount > 0) {
      message.warning(`批量导入完成：${description}`);
      notification.warning({
        message: '批量导入完成（部分失败）',
        description,
        placement: 'topRight',
        duration: 6,
      });
    } else {
      message.success(`批量导入完成：${description}`, 3);
      notification.success({
        message: '批量导入成功',
        description,
        placement: 'topRight',
        duration: 5,
      });
    }
  };

  const importFinished = results.length > 0 && !uploading;
  const successfulResults = results.filter((item) => item.report);
  const totalWritten = successfulResults.reduce(
    (sum, item) => sum + (item.report?.written_rows ?? item.report?.success_rows ?? 0),
    0,
  );

  return (
    <Modal
      open={open}
      title={`批量导入客户 xlsx（最多 ${MAX_IMPORT_FILES} 个）`}
      width={720}
      destroyOnClose
      closable={!uploading}
      maskClosable={!uploading}
      onCancel={() => { reset(); onCancel(); }}
      footer={[
        <Button key="close" disabled={uploading} onClick={() => { reset(); onCancel(); }}>关闭</Button>,
        <Button key="again" disabled={!importFinished} onClick={reset}>再传一批</Button>,
        <Button
          key="ok"
          type="primary"
          loading={uploading}
          disabled={files.length === 0 || importFinished}
          onClick={handleUpload}
        >
          开始导入（{files.length}）
        </Button>,
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="清洗 + 去重 + 身份证派生规则（固化在服务端）"
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><b>动态列识别</b>：基于 Excel 第 1 行表头名字自动匹配字段（支持手机号/移动电话/联系电话、地址/详细地址/现住址 等多种别名），列顺序不一致也能正确入库</li>
              <li>自动丢弃「所属户籍站」「编码1/2…」等噪声列；「居住地址」与「地址」同时出现时优先后者</li>
              <li>编码编号仅作为普通展示字段，非必填，不参与唯一性判断</li>
              <li>姓名和身份证为必填；缺失身份证或编码编号非数字的行会被跳过并留痕</li>
              <li><b>跨批次去重</b>：仅按身份证匹配，命中则合并（空值不覆盖已有数据）；同一身份证始终只保留一条客户记录</li>
              <li><b>身份证派生</b>：前 2 位 → 省份；前 4 位 → 城市；前 6 位 → 区县；7–14 位 → 出生日期；第 17 位 → 性别（Excel 原列有值时不覆盖；支持 15 位老身份证自动补 18 位）</li>
              <li>身份证中的非法日期会向前修正到最近合法日期并重新计算校验位，例如 2 月 30 日修正为当月最后一天</li>
              <li>身份证、手机号均以<b>明文</b>存储（一期不脱敏）</li>
            </ul>
          </Paragraph>
        }
      />

      {!importFinished && (
        <Dragger
          accept=".xlsx"
          multiple
          maxCount={MAX_IMPORT_FILES}
          disabled={uploading}
          beforeUpload={(f) => {
            if (!f.name.toLowerCase().endsWith('.xlsx')) {
              message.error(`仅支持 xlsx 文件：${f.name}`);
              return Upload.LIST_IGNORE;
            }
            return false;
          }}
          onChange={({ fileList }) => setFiles(fileList.slice(0, MAX_IMPORT_FILES))}
          onRemove={() => !uploading}
          fileList={files}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽 xlsx 文件到此处，单次最多 {MAX_IMPORT_FILES} 个</p>
          <p className="ant-upload-hint">
            单文件 ≤ 512MB；文件将按列表顺序逐个上传并导入，单个失败不会中断后续文件，请耐心等待不要刷新页面。
          </p>
        </Dragger>
      )}

      {uploading && (
        <div style={{ marginTop: 16 }}>
          <Progress percent={percent} status={percent === 100 ? 'active' : 'normal'} />
          <Text type="secondary">
            正在处理第 {currentFileIndex + 1}/{files.length} 个文件：
            {files[currentFileIndex]?.name ?? '-'}。上传完成后服务端会继续流式清洗与落库。
          </Text>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {importFinished && (
            <Alert
              type={results.some((item) => item.status === 'failed') ? 'warning' : 'success'}
              showIcon
              style={{ marginBottom: 12 }}
              message={`批量导入完成：成功 ${successfulResults.length} 个，失败 ${results.length - successfulResults.length} 个`}
              description={`所有成功文件共写入 ${totalWritten} 条客户数据。点击“查看详情”可检查单个文件的清洗结果。`}
            />
          )}
          <Table
            size="small"
            rowKey="uid"
            dataSource={results}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: '文件', dataIndex: 'fileName', ellipsis: true },
              {
                title: '状态',
                dataIndex: 'status',
                width: 80,
                render: (status: BatchImportResult['status']) => (
                  <Text type={status === 'success' ? 'success' : 'danger'}>
                    {status === 'success' ? '成功' : '失败'}
                  </Text>
                ),
              },
              {
                title: '写入',
                width: 90,
                render: (_: unknown, item: BatchImportResult) => (
                  item.report?.written_rows ?? item.report?.success_rows ?? '-'
                ),
              },
              {
                title: '跳过',
                width: 90,
                render: (_: unknown, item: BatchImportResult) => item.report?.skipped_rows ?? '-',
              },
              {
                title: '结果',
                render: (_: unknown, item: BatchImportResult) => (
                  item.report
                    ? <Button type="link" size="small" onClick={() => setReport(item.report ?? null)}>查看详情</Button>
                    : <Text type="danger">{item.error}</Text>
                ),
              },
            ]}
          />
        </div>
      )}

      {report && (
        <div style={{ marginTop: 16 }}>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            style={{ marginBottom: 12 }}
            message={`导入成功：共写入 ${report.written_rows ?? report.success_rows} 条客户数据`}
            description={
              <>
                文件 <Text code>{report.file_name}</Text>，耗时 {(report.elapsed_ms / 1000).toFixed(2)}s
                {report.skipped_rows ? <>；<Text type="warning">跳过 {report.skipped_rows} 行</Text></> : null}
                {report.conflict_warnings?.length
                  ? <>；<Text type="warning">身份证冲突 {report.conflict_warnings.length} 条（已入库）</Text></>
                  : null}
              </>
            }
          />
          <Paragraph>
            Job：<Text code>{report.job_id}</Text>　文件：<Text code>{report.file_name}</Text>　
            耗时：{(report.elapsed_ms / 1000).toFixed(2)}s
          </Paragraph>
          <Paragraph>
            总行数 <Text strong>{report.total_rows}</Text>　
            清洗成功 <Text strong style={{ color: '#52c41a' }}>{report.success_rows}</Text>　
            身份证去重 <Text strong style={{ color: '#1677ff' }}>{report.duplicate_rows ?? 0}</Text>　
            新增入库 <Text strong style={{ color: '#52c41a' }}>{report.inserted_rows ?? 0}</Text>　
            合并到已有 <Text strong style={{ color: '#1677ff' }}>{report.updated_rows ?? 0}</Text>　
            实际写入 <Text strong style={{ color: '#13c2c2' }}>{report.written_rows ?? report.success_rows}</Text>　
            跳过 <Text strong style={{ color: '#faad14' }}>{report.skipped_rows}</Text>
          </Paragraph>
          {report.detected_mapping && report.detected_mapping.length > 0 && (() => {
            const hitFields = new Set(report.detected_mapping.map((m) => m.field));
            const KEY_FIELDS: Array<{ key: string; label: string }> = [
              { key: 'name', label: '姓名' },
              { key: 'id_card', label: '身份证' },
              { key: 'phone_masked', label: '手机号' },
              { key: 'address', label: '地址' },
              { key: 'birth_date', label: '出生日期' },
              { key: 'gender', label: '性别' },
            ];
            const missing = KEY_FIELDS.filter((f) => !hitFields.has(f.key));
            return (
              <Alert
                type={missing.length === 0 ? 'success' : 'warning'}
                showIcon
                style={{ marginBottom: 12 }}
                message={missing.length === 0
                  ? `列识别成功：共识别 ${report.detected_mapping.length} 列，关键字段齐全`
                  : `列识别完成：共识别 ${report.detected_mapping.length} 列，但 ${missing.map((m) => m.label).join('、')} 未命中（请检查 Excel 表头名字）`}
                description={
                  <>
                    <Paragraph style={{ marginBottom: 8 }}>
                      <Text type="secondary">
                        若关键字段（如手机号/地址/身份证/区县）在表格中显示为空，可对照下表确认表头是否被正确识别。未命中字段会在数据库中为空，不会随意覆盖已有数据。
                      </Text>
                    </Paragraph>
                    <Table
                      size="small"
                      rowKey={(r) => `${r.index}-${r.field}`}
                      dataSource={report.detected_mapping}
                      pagination={false}
                      scroll={{ y: 180 }}
                      columns={[
                        { title: '列号', dataIndex: 'index', width: 60 },
                        { title: 'Excel 表头', dataIndex: 'header' },
                        { title: '识别为字段', dataIndex: 'field', render: (v: string) => <Text code>{v}</Text> },
                      ]}
                    />
                  </>
                }
              />
            );
          })()}
          {(report.conflict_warnings?.length ?? 0) > 0 && (
            <>
              <Paragraph type="warning">身份证冲突告警（编码号不同但身份证相同，已照常入库）</Paragraph>
              <Table
                size="small"
                rowKey={(r, i) => `${r.huji_no}-${i}`}
                dataSource={report.conflict_warnings}
                pagination={{ pageSize: 5 }}
                columns={[
                  { title: '当前编码号', dataIndex: 'huji_no', width: 160 },
                  { title: '已存在编码号', dataIndex: 'against', width: 160 },
                  { title: '原因', dataIndex: 'reason' },
                ]}
              />
            </>
          )}
          {report.warnings_summary && Object.keys(report.warnings_summary).length > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="清洗告警统计（非致命，已入库，仅供复核）"
              description={
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {Object.entries(report.warnings_summary).map(([k, v]) => (
                    <li key={k}>
                      <Text code>{k}</Text>：<b>{v}</b> 条
                      {k === 'id_card_district_unknown' && <>（身份证前 6 位未匹配到区县，可能是生僻码，可在 configs/gb2260.json 的 districts 补充）</>}
                      {k === 'id_card_city_unknown' && <>（身份证前 4 位未匹配到城市）</>}
                      {k === 'id_card_province_unknown' && <>（身份证前 2 位未匹配到省份）</>}
                      {k === 'id_card_birth_date_corrected' && <>（身份证中的非法日期已向前修正，并重新计算校验位）</>}
                      {k === 'id_card_checksum_invalid' && <>（身份证校验位失败，仍已入库）</>}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          {report.errors.length > 0 && (
            <>
              <Paragraph type="warning">异常行（最多显示前 100 条）</Paragraph>
              <Table
                size="small"
                rowKey={(r) => `${r.row}-${r.reason}`}
                dataSource={report.errors}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: '行号', dataIndex: 'row', width: 100 },
                  { title: '原因', dataIndex: 'reason' },
                ]}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

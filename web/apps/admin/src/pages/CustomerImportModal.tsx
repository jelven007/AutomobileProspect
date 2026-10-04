import { useState } from 'react';
import { Alert, App, Button, Modal, Progress, Table, Typography, Upload } from 'antd';
import { CheckCircleFilled, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import type { CustomerImportReport } from '@leadops/types';
import { api } from '../api';

const { Dragger } = Upload;
const { Paragraph, Text } = Typography;

export function CustomerImportModal({
  open,
  onCancel,
  onImported,
}: {
  open: boolean;
  onCancel: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [report, setReport] = useState<CustomerImportReport | null>(null);
  const { message, notification } = App.useApp();

  const reset = () => {
    setFile(null);
    setUploading(false);
    setPercent(0);
    setReport(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setPercent(0);
    setReport(null);
    try {
      const r = await api.customer.import(file, (loaded, total) => {
        setPercent(total ? Math.round((loaded / total) * 100) : 0);
      });
      setReport(r);
      const written = r.written_rows ?? r.success_rows;
      const hasIssue = (r.skipped_rows ?? 0) > 0 || (r.conflict_warnings?.length ?? 0) > 0;
      message.success(`导入完成：新增 ${r.inserted_rows ?? 0}，合并 ${r.updated_rows ?? 0}，跳过 ${r.skipped_rows}`, 3);
      notification[hasIssue ? 'warning' : 'success']({
        message: hasIssue ? 'Excel 导入完成（含告警）' : 'Excel 导入成功',
        description: (
          <>
            文件 <Text code>{r.file_name}</Text> 共 <b>{r.total_rows}</b> 行，
            实际写入 <b style={{ color: '#52c41a' }}>{written}</b> 条（
            新增 <b>{r.inserted_rows ?? 0}</b>，合并 <b>{r.updated_rows ?? 0}</b>）
            {r.duplicate_rows ? <>，文件内去重 <b>{r.duplicate_rows}</b> 条</> : null}
            {r.skipped_rows ? <>，跳过 <b style={{ color: '#faad14' }}>{r.skipped_rows}</b> 条</> : null}
            {r.conflict_warnings?.length
              ? <>，身份证冲突 <b style={{ color: '#faad14' }}>{r.conflict_warnings.length}</b> 条</>
              : null}
            。耗时 {(r.elapsed_ms / 1000).toFixed(2)}s
          </>
        ),
        placement: 'topRight',
        duration: 5,
      });
      onImported();
    } catch (e) {
      message.error((e as Error).message);
      notification.error({
        message: 'Excel 导入失败',
        description: (e as Error).message,
        placement: 'topRight',
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open={open}
      title="批量导入客户 xlsx"
      width={720}
      destroyOnClose
      onCancel={() => { reset(); onCancel(); }}
      footer={[
        <Button key="close" onClick={() => { reset(); onCancel(); }}>关闭</Button>,
        <Button key="again" disabled={!report} onClick={reset}>再传一个</Button>,
        <Button key="ok" type="primary" loading={uploading} disabled={!file || !!report} onClick={handleUpload}>
          开始导入
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
              <li>编码编号自动去除「2016户籍统计」前缀仅保留数字；<b>非必填</b>，缺失时按匿名记录入库</li>
              <li>姓名为必填；编码编号非数字的行会被跳过并留痕</li>
              <li><b>跨批次去重</b>：按 编码编号 → 身份证 → (姓名+手机号) 顺序匹配，命中则合并（空值不覆盖已有数据），未命中则新增</li>
              <li>编码编号不同但身份证相同的行视为疑似冲突，不丢弃，仅在导入报告中告警</li>
              <li><b>身份证派生</b>：前 2 位 → 省份；前 4 位 → 城市；前 6 位 → 区县；7–14 位 → 出生日期；第 17 位 → 性别（Excel 原列有值时不覆盖；支持 15 位老身份证自动补 18 位）</li>
              <li>身份证、手机号均以<b>明文</b>存储（一期不脱敏）</li>
            </ul>
          </Paragraph>
        }
      />

      {!report && (
        <Dragger
          accept=".xlsx"
          multiple={false}
          maxCount={1}
          beforeUpload={(f) => {
            setFile(f);
            return false;
          }}
          onRemove={() => setFile(null)}
          fileList={file ? ([{ uid: '1', name: file.name, status: 'done' } as UploadFile]) : []}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽 xlsx 文件到此处</p>
          <p className="ant-upload-hint">
            单文件 ≤ 512MB；200MB 级别文件预计清洗 3–10 分钟，服务端流式处理不占用浏览器内存，请耐心等待不要刷新页面。
          </p>
        </Dragger>
      )}

      {uploading && (
        <div style={{ marginTop: 16 }}>
          <Progress percent={percent} status={percent === 100 ? 'active' : 'normal'} />
          <Text type="secondary">
            {percent < 100
              ? '上传中，上传完成后服务端会流式清洗与落库，结果将在此展示…'
              : '上传完成，服务端正在流式清洗与落库（大文件可能需要数分钟，期间进度条会保持在 100%，请勿关闭页面）…'}
          </Text>
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
            文件内去重 <Text strong style={{ color: '#1677ff' }}>{report.duplicate_rows ?? 0}</Text>　
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

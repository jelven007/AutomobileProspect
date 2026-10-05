import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Customer, CustomerListQuery } from '@leadops/types';
import { PageContainer } from '@leadops/ui';
import { api } from '../api';
import { CustomerImportModal } from './CustomerImportModal';
import { ResizableHeader } from '../components/ResizableHeader';

const tableComponents = { header: { cell: ResizableHeader } };

const DOCUMENT_LABELS: Record<string, string> = {
  resident_id: '居民身份证',
  organization_code: '组织机构代码',
  credit_code: '统一社会信用代码',
  passport_cn: '中国普通护照',
  hk_macao_permit: '往来港澳通行证',
  mainland_permit: '港澳居民来往内地通行证',
  taiwan_permit: '台湾居民来往大陆通行证',
  hongkong_id: '香港居民身份证',
  pending_document: '证件类型待核实',
};
const documentOptions = Object.entries(DOCUMENT_LABELS).map(([value, label]) => ({ value, label }));
const documentErrors: Record<string, string> = {
  invalid_id_card_format: '证件号码未通过所选类型的格式或校验位检查',
  unsupported_document_type: '请选择支持的证件类型',
  ambiguous_document_type: '此号码可能属于多种证件，请选择证件类型',
  id_card_required: '请输入证件号码',
  id_card_exists: '相同证件类型和号码的客户已存在',
};

export default function CustomerPage() {
  const [query, setQuery] = useState<CustomerListQuery>({ limit: 50, page: 1 });
  const [jumpPage, setJumpPage] = useState<number | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [expandedContent, setExpandedContent] = useState(false);
  const tableArea = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState(400);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const qc = useQueryClient();
  const { message, notification } = App.useApp();

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['customer', query],
    queryFn: () => api.customer.list(query),
    placeholderData: keepPreviousData,
  });

  useLayoutEffect(() => {
    if (!tableArea.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setTableHeight(Math.max(100, Math.floor(entry.contentRect.height) - 56));
    });
    observer.observe(tableArea.current);
    return () => observer.disconnect();
  }, []);

  const currentPage = data?.page ?? query.page ?? 1;
  const totalPages = data?.total_pages ?? 0;
  const updateFilters = (patch: Partial<CustomerListQuery>) => {
    setQuery((previous) => ({ ...previous, ...patch, page: 1, cursor: undefined }));
    setJumpPage(null);
    setSelectedIds([]);
  };
  const goToPage = (page: number) => {
    setQuery((previous) => ({ ...previous, page: Math.max(1, Math.min(totalPages || 1, Math.floor(page))), cursor: undefined }));
    setJumpPage(null);
    setSelectedIds([]);
  };

  const { data: facets } = useQuery({
    queryKey: ['customer-facets'],
    queryFn: () => api.customer.facets(),
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['customer'] });
    qc.invalidateQueries({ queryKey: ['customer-facets'] });
  };

  const removeMut = useMutation({
    mutationFn: (id: string) => api.customer.remove(id),
    onSuccess: () => { message.success('已删除'); refreshAll(); },
  });

  const batchDeleteMut = useMutation({
    mutationFn: (ids: string[]) => api.customer.batchDelete(ids),
    onSuccess: (r) => { message.success(`已删除 ${r.deleted} 条`); setSelectedIds([]); refreshAll(); },
  });

  const removeAllMut = useMutation({
    mutationFn: () => api.customer.removeAll(),
    onSuccess: (r) => { message.success(`已清空 ${r.deleted} 条`); setSelectedIds([]); refreshAll(); },
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      const { q, address, province, city, district, gender, id_type } = query;
      let job = await api.customer.startExport({ q, address, province, city, district, gender, id_type });
      message.info(`导出任务已创建：${job.job_id}`);
      const deadline = Date.now() + 15 * 60 * 1000;
      while (job.status === 'PENDING' || job.status === 'RUNNING') {
        if (Date.now() >= deadline) throw new Error('导出仍在后台运行，请稍后重试');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        job = await api.customer.exportStatus(job.job_id);
      }
      if (job.status === 'FAILED') throw new Error(job.error ?? 'export_failed');
      if (job.total_rows === 0) {
        message.warning('当前筛选条件下没有数据可导出');
        return;
      }
      const result = await api.customer.downloadExport(job);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notification.success({
        message: '导出成功',
        description: `共 ${job.total_rows} 条，已按省市拆分为 ${job.groups} 个 Excel（省份-城市-条数.xlsx），打包成 ZIP 下载至浏览器的「下载」目录`,
        placement: 'topRight',
        duration: 6,
      });
    } catch (e) {
      notification.error({ message: '导出失败', description: (e as Error).message, placement: 'topRight' });
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    { title: '编码编号', dataIndex: 'huji_no', width: 120, ellipsis: true },
    { title: '姓名', dataIndex: 'name', width: 72, ellipsis: true },
    { title: '证件类型', dataIndex: 'id_type', width: 150, ellipsis: true,
      render: (value: string) => DOCUMENT_LABELS[value] ?? value },
    { title: '证件号码', dataIndex: 'id_card', width: 180, ellipsis: true },
    { title: '出生日期', dataIndex: 'birth_date', width: 100, ellipsis: true },
    {
      title: '性别',
      dataIndex: 'gender',
      width: 56,
      ellipsis: true,
      render: (v: 'M' | 'F' | 'U') => <Tag style={{ marginInlineEnd: 0 }}>{v === 'M' ? '男' : v === 'F' ? '女' : '未知'}</Tag>,
    },
    { title: '手机号', dataIndex: 'phone_masked', width: 120, ellipsis: true },
    { title: '省份', dataIndex: 'province', width: 90, ellipsis: true },
    { title: '城市', dataIndex: 'city', width: 90, ellipsis: true },
    { title: '区县', dataIndex: 'district', width: 100, ellipsis: true },
    { title: '地址', dataIndex: 'address', width: 220, ellipsis: true },
    { title: '职业', dataIndex: 'occupation', width: 90, ellipsis: true },
    { title: '学历', dataIndex: 'education', width: 80, ellipsis: true },
    { title: '婚姻', dataIndex: 'marital_status', width: 70, ellipsis: true },
    {
      title: '统计时间',
      dataIndex: 'stat_time',
      width: 100,
      ellipsis: true,
      render: (v: string | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : ''),
    },
    { title: '入库批次', dataIndex: 'ingest_batch', width: 140, ellipsis: true },
    {
      title: '操作',
      key: 'action',
      width: 128,
      fixed: 'right' as const,
      render: (_: unknown, r: Customer) => (
        <Space size={4}>
          <Button size="small" onClick={() => setEditing(r)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => removeMut.mutate(r.customer_id)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const resizableColumns = columns.map((column) => {
    const key = column.dataIndex ?? column.key!;
    return {
      ...column,
      ellipsis: !expandedContent,
      width: columnWidths[key] ?? column.width,
      onHeaderCell: () => ({
        style: { width: columnWidths[key] ?? column.width },
        columnWidth: columnWidths[key] ?? column.width,
        resizeLabel: column.title,
        onColumnResize: (width: number) => setColumnWidths((previous) => ({ ...previous, [key]: width })),
        onColumnReset: () => setColumnWidths((previous) => ({ ...previous, [key]: column.width })),
      }),
    };
  });

  const toOptions = (xs: string[] = []) => xs.map((v) => ({ label: v, value: v }));

  return (
    <PageContainer
      title="客户管理"
      className="customer-page"
      extra={
        <Space size={16}>
          <span style={{ fontSize: 14 }}>
            总条数：
            <b style={{ color: '#1677ff', fontSize: 18, marginInlineStart: 4 }}>
              {(data?.total ?? 0).toLocaleString('en-US')}
            </b>
            {data?.total && selectedIds.length > 0 ? (
              <span style={{ color: '#999', marginInlineStart: 8 }}>（已选 {selectedIds.length}）</span>
            ) : null}
          </span>
        </Space>
      }
    >
      <Space wrap size={[8, 8]} className="customer-filters">
        <Input.Search
          placeholder="按姓名搜索"
          aria-label="按姓名搜索"
          size="small"
          allowClear
          style={{ width: 180 }}
          onSearch={(v) => updateFilters({ q: v || undefined })}
        />
        <Input
          placeholder="地址关键字"
          aria-label="地址关键字"
          size="small"
          allowClear
          style={{ width: 136 }}
          onChange={(e) => updateFilters({ address: e.target.value || undefined })}
        />
        <Select
          placeholder="省份"
          aria-label="省份筛选"
          size="small"
          allowClear
          showSearch
          style={{ width: 108 }}
          options={toOptions(facets?.province)}
          value={query.province}
          onChange={(v) => updateFilters({ province: v || undefined })}
        />
        <Select
          placeholder="城市"
          aria-label="城市筛选"
          size="small"
          allowClear
          showSearch
          style={{ width: 108 }}
          options={toOptions(facets?.city)}
          value={query.city}
          onChange={(v) => updateFilters({ city: v || undefined })}
        />
        <Select
          placeholder="区县"
          aria-label="区县筛选"
          size="small"
          allowClear
          showSearch
          style={{ width: 108 }}
          options={toOptions(facets?.district)}
          value={query.district}
          onChange={(v) => updateFilters({ district: v || undefined })}
        />
        <Select
          placeholder="性别"
          aria-label="性别筛选"
          size="small"
          allowClear
          style={{ width: 80 }}
          options={[
            { label: '男', value: 'M' },
            { label: '女', value: 'F' },
            { label: '未知', value: 'U' },
          ]}
          value={query.gender}
          onChange={(v) => updateFilters({ gender: v })}
        />
        <Select
          placeholder="证件类型"
          aria-label="证件类型筛选"
          size="small"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 156 }}
          popupMatchSelectWidth={240}
          options={documentOptions}
          value={query.id_type}
          onChange={(value) => updateFilters({ id_type: value })}
        />
      </Space>
      <Space wrap size={[8, 8]} className="customer-actions">
        <Button size="small" type="primary" onClick={() => setCreating(true)}>新增客户</Button>
        <Button size="small" onClick={() => setImporting(true)}>批量导入</Button>
        <Button size="small" loading={exporting} onClick={handleExport}>
          批量导出
        </Button>
        <Popconfirm
          title={`批量删除选中的 ${selectedIds.length} 条？`}
          disabled={selectedIds.length === 0}
          onConfirm={() => batchDeleteMut.mutate(selectedIds)}
        >
          <Button size="small" danger disabled={selectedIds.length === 0}>
            批量删除{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
        </Popconfirm>
        <Popconfirm
          title="确认停用全部客户数据？记录将软删除并保留审计"
          okText="全部清空"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeAllMut.mutate()}
        >
          <Button size="small" danger>清空全部</Button>
        </Popconfirm>
        <Button size="small" loading={isFetching} onClick={() => refetch()}>刷新</Button>
        <Button size="small" aria-pressed={expandedContent} onClick={() => setExpandedContent((value) => !value)}>
          {expandedContent ? '收起内容' : '展开内容'}
        </Button>
      </Space>

      {error && <Alert type="error" showIcon message="查询失败，请刷新重试" className="customer-query-error" />}
      <div ref={tableArea} className="customer-table-area">
      <Table
        rowKey="customer_id"
        size="small"
        tableLayout="fixed"
        loading={isFetching}
        columns={resizableColumns}
        components={tableComponents}
        dataSource={data?.items ?? []}
        pagination={false}
        scroll={{ x: resizableColumns.reduce((sum, column) => sum + column.width, 48), y: tableHeight }}
        className={expandedContent ? 'customer-table-expanded' : 'customer-table-nowrap'}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
      />
      </div>

      <Space wrap size={[8, 8]} className="customer-pagination" aria-label="客户分页">
        <Select
          size="small"
          aria-label="每页条数"
          style={{ width: 110 }}
          value={query.limit ?? 50}
          onChange={(v) => updateFilters({ limit: v })}
          options={[
            { label: '50 条/页', value: 50 },
            { label: '100 条/页', value: 100 },
            { label: '200 条/页', value: 200 },
          ]}
        />
        <span>第 {totalPages === 0 ? 0 : currentPage} / {totalPages.toLocaleString('en-US')} 页</span>
        <Button size="small" disabled={isFetching || currentPage <= 1 || totalPages === 0} onClick={() => goToPage(1)}>首页</Button>
        <Button size="small" disabled={isFetching || currentPage <= 1 || totalPages === 0} onClick={() => goToPage(currentPage - 1)}>上一页</Button>
        <Button size="small" disabled={isFetching || currentPage >= totalPages} onClick={() => goToPage(currentPage + 1)}>
          下一页
        </Button>
        <Button size="small" disabled={isFetching || currentPage >= totalPages} onClick={() => goToPage(totalPages)}>尾页</Button>
        <span>跳至</span>
        <InputNumber size="small" aria-label="跳转页码" min={1} max={Math.max(1, totalPages)} precision={0}
          style={{ width: 90 }} value={jumpPage ?? currentPage} onChange={setJumpPage}
          disabled={isFetching || totalPages === 0}
          onPressEnter={() => goToPage(jumpPage ?? currentPage)} />
        <Button size="small" disabled={isFetching || totalPages === 0} onClick={() => goToPage(jumpPage ?? currentPage)}>跳转</Button>
        <span className="customer-page-count">当前展示 {data?.items.length ?? 0} 条</span>
      </Space>

      <CustomerEditor
        open={!!editing || creating}
        value={editing}
        onCancel={() => { setEditing(null); setCreating(false); }}
        onSaved={() => {
          setEditing(null); setCreating(false);
          refreshAll();
        }}
      />

      <CustomerImportModal
        open={importing}
        onCancel={() => setImporting(false)}
        onImported={refreshAll}
      />
    </PageContainer>
  );
}

function CustomerEditor({
  open, value, onCancel, onSaved,
}: {
  open: boolean;
  value: Customer | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<Partial<Customer>>();
  const isEdit = !!value;
  const { message } = App.useApp();

  const mut = useMutation({
    mutationFn: async (dto: Partial<Customer>) => {
      if (isEdit && value) return api.customer.update(value.customer_id, { ...dto, version: value.version });
      return api.customer.create(dto);
    },
    onSuccess: () => {
      message.success(isEdit ? '已更新' : '已新增');
      onSaved();
    },
    onError: (e: Error) => message.error(documentErrors[e.message] ?? e.message),
  });

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑客户' : '新增客户'}
      destroyOnClose
      onCancel={onCancel}
      onOk={async () => {
        const raw = await form.validateFields();
        const dto = {
          ...raw,
          birth_date: raw.birth_date
            ? (dayjs.isDayjs(raw.birth_date) ? raw.birth_date.format('YYYY-MM-DD') : raw.birth_date)
            : undefined,
          stat_time: raw.stat_time
            ? (dayjs.isDayjs(raw.stat_time) ? raw.stat_time.format('YYYY-MM-DD') : raw.stat_time)
            : undefined,
        };
        mut.mutate(dto);
      }}
      confirmLoading={mut.isPending}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          value
            ? {
                ...value,
                birth_date: value.birth_date ? dayjs(value.birth_date) : undefined,
                stat_time: value.stat_time ? dayjs(value.stat_time) : undefined,
              }
            : { gender: 'U', id_type: 'resident_id' }
        }
        preserve={false}
      >
        <Form.Item
          name="huji_no"
          label="编码编号"
          rules={[{ pattern: /^\d+$/, message: '必须为纯数字' }]}
          tooltip="选填；仅作为普通展示字段，不参与唯一性判断"
        >
          <Input placeholder="可留空" />
        </Form.Item>
        <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="gender" label="性别">
          <Select options={[{ label: '男', value: 'M' }, { label: '女', value: 'F' }, { label: '未知', value: 'U' }]} />
        </Form.Item>
        <Form.Item name="birth_date" label="出生日期">
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="选择日期" />
        </Form.Item>
        <Form.Item name="id_type" label="证件类型" rules={[{ required: true }]}>
          <Select options={documentOptions} />
        </Form.Item>
        <Form.Item
          name="id_card"
          label="证件号码"
          rules={[{ required: true, whitespace: true, message: '请输入证件号码' }, { max: 32, message: '最多 32 个字符' }]}
          tooltip="按所选类型校验；同类型、同号码对应同一客户。待核实仅用于同时符合多种格式的号码，确认后可修改类型"
        >
          <Input placeholder="输入完整证件号码" />
        </Form.Item>
        <Form.Item name="phone_masked" label="手机号">
          <Input placeholder="明文存储（一期不脱敏）" />
        </Form.Item>
        <Form.Item name="address" label="地址">
          <Input.TextArea rows={2} placeholder="户籍地或联系地址" />
        </Form.Item>
        <Form.Item name="province" label="省份" tooltip="居民身份证可自动推导；其他证件请填写">
          <Input placeholder="如 四川省" />
        </Form.Item>
        <Form.Item name="city" label="城市" tooltip="居民身份证可自动推导；其他证件请填写">
          <Input placeholder="如 内江市" />
        </Form.Item>
        <Form.Item name="district" label="区县" tooltip="居民身份证可自动推导；其他证件请填写">
          <Input placeholder="如 市中区" />
        </Form.Item>
        <Form.Item name="occupation" label="职业">
          <Input />
        </Form.Item>
        <Form.Item name="education" label="学历">
          <Select
            allowClear
            options={[
              { label: '小学', value: '小学' },
              { label: '初中', value: '初中' },
              { label: '高中/中专', value: '高中/中专' },
              { label: '大专', value: '大专' },
              { label: '本科', value: '本科' },
              { label: '硕士', value: '硕士' },
              { label: '博士', value: '博士' },
            ]}
          />
        </Form.Item>
        <Form.Item name="marital_status" label="婚姻">
          <Select
            allowClear
            options={[
              { label: '未婚', value: '未婚' },
              { label: '已婚', value: '已婚' },
              { label: '离异', value: '离异' },
              { label: '丧偶', value: '丧偶' },
            ]}
          />
        </Form.Item>
        <Form.Item name="stat_time" label="统计时间">
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="选择日期" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

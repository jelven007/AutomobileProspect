import { useState } from 'react';
import { App, Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Customer, CustomerListQuery } from '@leadops/types';
import { PageContainer } from '@leadops/ui';
import { api } from '../api';
import { CustomerImportModal } from './CustomerImportModal';

export default function CustomerPage() {
  const [query, setQuery] = useState<CustomerListQuery>({ limit: 50 });
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const qc = useQueryClient();
  const { message, notification } = App.useApp();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['customer', query],
    queryFn: () => api.customer.list(query),
  });

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
      const { q, address, province, city, district, gender } = query;
      const r = await api.customer.export({ q, address, province, city, district, gender });
      if (r.total === 0) {
        message.warning('当前筛选条件下没有数据可导出');
        return;
      }
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notification.success({
        message: '导出成功',
        description: `共 ${r.total} 条，已按省市拆分为 ${r.groups} 个 Excel（省份-城市-条数.xlsx），打包成 ZIP 下载至浏览器的「下载」目录`,
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
    { title: '身份证', dataIndex: 'id_card', width: 180, ellipsis: true },
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

  const toOptions = (xs: string[] = []) => xs.map((v) => ({ label: v, value: v }));

  return (
    <PageContainer
      title="客户管理"
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
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="按姓名/编码编号搜索"
          allowClear
          style={{ width: 240 }}
          onSearch={(v) => setQuery((q) => ({ ...q, q: v || undefined, cursor: undefined }))}
        />
        <Input
          placeholder="地址关键字"
          allowClear
          style={{ width: 160 }}
          onChange={(e) => setQuery((q) => ({ ...q, address: e.target.value || undefined, cursor: undefined }))}
        />
        <Select
          placeholder="省份"
          allowClear
          showSearch
          style={{ width: 140 }}
          options={toOptions(facets?.province)}
          value={query.province}
          onChange={(v) => setQuery((q) => ({ ...q, province: v || undefined, cursor: undefined }))}
        />
        <Select
          placeholder="城市"
          allowClear
          showSearch
          style={{ width: 140 }}
          options={toOptions(facets?.city)}
          value={query.city}
          onChange={(v) => setQuery((q) => ({ ...q, city: v || undefined, cursor: undefined }))}
        />
        <Select
          placeholder="区县"
          allowClear
          showSearch
          style={{ width: 140 }}
          options={toOptions(facets?.district)}
          value={query.district}
          onChange={(v) => setQuery((q) => ({ ...q, district: v || undefined, cursor: undefined }))}
        />
        <Select
          placeholder="性别"
          allowClear
          style={{ width: 110 }}
          options={[
            { label: '男', value: 'M' },
            { label: '女', value: 'F' },
            { label: '未知', value: 'U' },
          ]}
          value={query.gender}
          onChange={(v) => setQuery((q) => ({ ...q, gender: v, cursor: undefined }))}
        />
        <Button type="primary" onClick={() => setCreating(true)}>新增客户</Button>
        <Button onClick={() => setImporting(true)}>批量导入 xlsx</Button>
        <Button loading={exporting} onClick={handleExport}>
          导出 Excel（按城市分文件）
        </Button>
        <Popconfirm
          title={`批量删除选中的 ${selectedIds.length} 条？`}
          disabled={selectedIds.length === 0}
          onConfirm={() => batchDeleteMut.mutate(selectedIds)}
        >
          <Button danger disabled={selectedIds.length === 0}>
            批量删除{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
        </Popconfirm>
        <Popconfirm
          title="确认清空全部客户数据？此操作不可恢复"
          okText="全部清空"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeAllMut.mutate()}
        >
          <Button danger>清空全部</Button>
        </Popconfirm>
        <Button onClick={() => refetch()}>刷新</Button>
      </Space>

      <Table
        rowKey="customer_id"
        size="small"
        tableLayout="fixed"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        pagination={false}
        scroll={{ x: 1920, y: 'calc(100vh - 260px)' }}
        className="customer-table-nowrap"
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
      />

      <Space style={{ marginTop: 8 }}>
        <Select
          size="small"
          style={{ width: 110 }}
          value={query.limit ?? 50}
          onChange={(v) => setQuery((q) => ({ ...q, limit: v, cursor: undefined }))}
          options={[
            { label: '50 条/页', value: 50 },
            { label: '100 条/页', value: 100 },
            { label: '200 条/页', value: 200 },
          ]}
        />
        <Button size="small" disabled={!data?.next_cursor} onClick={() => setQuery((q) => ({ ...q, cursor: data?.next_cursor }))}>
          下一页
        </Button>
        <span style={{ color: '#999', fontSize: 12 }}>当前展示 {data?.items.length ?? 0} 条</span>
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
    onError: (e: Error) => message.error(e.message),
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
            : { gender: 'U' }
        }
        preserve={false}
      >
        <Form.Item
          name="huji_no"
          label="编码编号"
          rules={[{ pattern: /^\d+$/, message: '必须为纯数字' }]}
          tooltip="选填；留空时系统按新增记录保存"
        >
          <Input disabled={isEdit} placeholder="可留空" />
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
        <Form.Item name="id_card" label="身份证（18 位）" rules={[{ pattern: /^\d{17}[\dXx]$/, message: '身份证格式不正确' }]}>
          <Input placeholder="明文存储（一期不脱敏）" />
        </Form.Item>
        <Form.Item name="phone_masked" label="手机号">
          <Input placeholder="明文存储（一期不脱敏）" />
        </Form.Item>
        <Form.Item name="address" label="地址">
          <Input.TextArea rows={2} placeholder="户籍地或联系地址" />
        </Form.Item>
        <Form.Item name="province" label="省份" tooltip="留空时服务端自动按身份证前 2 位推导">
          <Input placeholder="如 四川省" />
        </Form.Item>
        <Form.Item name="city" label="城市" tooltip="留空时服务端自动按身份证前 4 位推导">
          <Input placeholder="如 内江市" />
        </Form.Item>
        <Form.Item name="district" label="区县" tooltip="留空时服务端自动按身份证前 6 位推导">
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

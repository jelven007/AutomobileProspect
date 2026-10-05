import { useState } from 'react';
import { App, Button, Popconfirm, Progress, Space, Table, Tag, Tooltip } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExportJob } from '@leadops/types';
import { PageContainer } from '@leadops/ui';
import { api } from '../api';

const STATUS: Record<ExportJob['status'], { color: string; label: string }> = {
  PENDING: { color: 'default', label: '排队中' },
  RUNNING: { color: 'processing', label: '处理中' },
  PAUSING: { color: 'processing', label: '暂停中' },
  PAUSED: { color: 'warning', label: '已暂停' },
  SUCCESS: { color: 'success', label: '已完成' },
  FAILED: { color: 'error', label: '失败' },
};

function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function progressOf(job: ExportJob): number {
  if (job.status === 'SUCCESS') return 100;
  if (job.total_rows <= 0) return 0;
  return Math.min(99, Math.round(job.processed_rows / job.total_rows * 100));
}

function filterSummary(job: ExportJob): string {
  const filters = job.filters ?? {};
  const values = [
    filters.q && `姓名：${filters.q}`,
    filters.address && `地址：${filters.address}`,
    filters.province,
    filters.city,
    filters.district,
    filters.gender && `性别：${filters.gender === 'M' ? '男' : filters.gender === 'F' ? '女' : '未知'}`,
    filters.id_type && `证件：${filters.id_type}`,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' / ') : '全部客户';
}

export default function ExportJobsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState<string>();
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['export-jobs'],
    queryFn: () => api.customer.exportJobs(),
    refetchInterval: (query) => (
      query.state.data?.some((job) => (
        job.status === 'RUNNING' || job.status === 'PENDING' || job.status === 'PAUSING'
      ))
        ? 2000
        : false
    ),
  });
  const active = data?.filter((job) => (
    job.status === 'RUNNING' || job.status === 'PENDING' || job.status === 'PAUSING'
  )).length ?? 0;
  const refreshJobs = () => queryClient.invalidateQueries({ queryKey: ['export-jobs'] });
  const retry = useMutation({
    mutationFn: (job: ExportJob) => api.customer.startExport(job.filters ?? {}),
    onSuccess: () => {
      message.success('已创建新的导出任务');
      refreshJobs();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const pause = useMutation({
    mutationFn: (jobId: string) => api.customer.pauseExport(jobId),
    onSuccess: (job) => {
      message.success(job.status === 'PAUSING' ? '暂停请求已提交' : '导出任务已暂停');
      refreshJobs();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const resume = useMutation({
    mutationFn: (jobId: string) => api.customer.resumeExport(jobId),
    onSuccess: () => {
      message.success('导出任务已继续');
      refreshJobs();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (jobId: string) => api.customer.removeExport(jobId),
    onSuccess: () => {
      message.success('导出任务已删除');
      refreshJobs();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const download = async (job: ExportJob) => {
    setDownloading(job.job_id);
    try {
      const result = await api.customer.downloadExport(job);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      message.success('导出文件已下载');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setDownloading(undefined);
    }
  };

  return (
    <PageContainer
      title="导出任务"
      extra={
        <Space>
          <span className="export-task-summary">运行中 {active} 个</span>
          <Button size="small" icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="job_id"
        size="small"
        loading={isFetching && !data}
        dataSource={data ?? []}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        scroll={{ x: 1180 }}
        columns={[
          {
            title: '任务',
            dataIndex: 'job_id',
            width: 190,
            ellipsis: true,
            render: (value: string) => <Tooltip title={value}>{value}</Tooltip>,
          },
          {
            title: '筛选范围',
            width: 230,
            ellipsis: true,
            render: (_: unknown, job: ExportJob) => {
              const value = filterSummary(job);
              return <Tooltip title={value}>{value}</Tooltip>;
            },
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (value: ExportJob['status']) => (
              <Tag color={STATUS[value].color}>{STATUS[value].label}</Tag>
            ),
          },
          {
            title: '进度',
            width: 220,
            render: (_: unknown, job: ExportJob) => (
              <Progress
                percent={progressOf(job)}
                size="small"
                status={job.status === 'FAILED' ? 'exception' : undefined}
                format={(percent) => `${percent}%`}
              />
            ),
          },
          {
            title: '数据行',
            width: 130,
            render: (_: unknown, job: ExportJob) => (
              `${job.processed_rows.toLocaleString()} / ${job.total_rows.toLocaleString()}`
            ),
          },
          {
            title: '文件',
            width: 90,
            render: (_: unknown, job: ExportJob) => `${job.completed_groups} / ${job.groups}`,
          },
          { title: '创建时间', dataIndex: 'created_at', width: 170, render: formatTime },
          { title: '完成时间', dataIndex: 'finished_at', width: 170, render: formatTime },
          {
            title: '结果',
            width: 160,
            ellipsis: true,
            render: (_: unknown, job: ExportJob) => job.error
              ? <Tooltip title={job.error}><span className="export-task-error">{job.error}</span></Tooltip>
              : job.file_name ?? '-',
          },
          {
            title: '操作',
            key: 'action',
            fixed: 'right',
            width: 230,
            render: (_: unknown, job: ExportJob) => {
              const expired = !!job.expires_at && new Date(job.expires_at).getTime() <= Date.now();
              const isActive = job.status === 'RUNNING' || job.status === 'PAUSING';
              return (
                <Space size={4}>
                  {job.status === 'SUCCESS' ? (
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={expired}
                      loading={downloading === job.job_id}
                      title={expired ? '文件已过期' : '下载 ZIP'}
                      onClick={() => download(job)}
                    >
                      下载
                    </Button>
                  ) : null}
                  {(job.status === 'PENDING' || job.status === 'RUNNING') ? (
                    <Button
                      size="small"
                      icon={<PauseCircleOutlined />}
                      loading={pause.isPending && pause.variables === job.job_id}
                      onClick={() => pause.mutate(job.job_id)}
                    >
                      暂停
                    </Button>
                  ) : null}
                  {job.status === 'PAUSING' ? (
                    <Button size="small" icon={<PauseCircleOutlined />} loading disabled>
                      暂停
                    </Button>
                  ) : null}
                  {job.status === 'PAUSED' ? (
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      loading={resume.isPending && resume.variables === job.job_id}
                      onClick={() => resume.mutate(job.job_id)}
                    >
                      继续
                    </Button>
                  ) : null}
                  {job.status === 'FAILED' && (
                    <Button size="small" loading={retry.isPending && retry.variables?.job_id === job.job_id}
                      onClick={() => retry.mutate(job)}>
                      重试
                    </Button>
                  )}
                  <Popconfirm
                    title="删除导出任务"
                    description={isActive ? '请先暂停任务，再执行删除。' : '任务记录和已生成文件将一并删除。'}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    disabled={isActive}
                    onConfirm={() => remove.mutate(job.job_id)}
                  >
                    <Tooltip title={isActive ? '请先暂停任务' : '删除任务'}>
                      <Button
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        disabled={isActive}
                        loading={remove.isPending && remove.variables === job.job_id}
                        aria-label="删除任务"
                      />
                    </Tooltip>
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />
    </PageContainer>
  );
}

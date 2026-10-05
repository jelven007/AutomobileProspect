import { Button, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IngestJob } from '@leadops/types';
import { PageContainer } from '@leadops/ui';
import { api } from '../api';

const STATUS_COLOR: Record<IngestJob['status'], string> = {
  PENDING: 'default',
  RUNNING: 'processing',
  SUCCESS: 'success',
  FAILED: 'error',
  SUPERSEDED: 'default',
};

const CHINA_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatChinaTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = Object.fromEntries(
    CHINA_TIME_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export default function IngestJobsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['ingest-jobs'],
    queryFn: () => api.ingestJobs.list(),
    refetchInterval: (query) => (
      query.state.data?.some((job) => job.status === 'RUNNING' || job.status === 'PENDING')
        ? 2000
        : false
    ),
  });

  const retry = useMutation({
    mutationFn: (jobId: string) => api.ingestJobs.retry(jobId),
    onSuccess: () => {
      message.success('已触发重跑');
      qc.invalidateQueries({ queryKey: ['ingest-jobs'] });
    },
  });

  return (
    <PageContainer title="同步任务">
      <Table
        className="ingest-jobs-table"
        rowKey="job_id"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Job ID', dataIndex: 'job_id', width: 230, ellipsis: true },
          {
            title: '来源',
            width: 220,
            ellipsis: true,
            render: (_: unknown, j: IngestJob) => (
              j.file_name ?? [j.source_bucket, j.source_prefix].filter(Boolean).join('/') ?? '-'
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: IngestJob['status']) => <Tag color={STATUS_COLOR[s]}>{s}</Tag>,
          },
          { title: '总行数', dataIndex: 'total_rows' },
          { title: '成功', dataIndex: 'success_rows' },
          { title: '新增', dataIndex: 'inserted_rows' },
          { title: '重复', dataIndex: 'updated_rows' },
          { title: '跳过', dataIndex: 'skipped_rows' },
          { title: 'Checkpoint', dataIndex: 'checkpoint_row' },
          { title: '开始', dataIndex: 'started_at', width: 150, render: formatChinaTime },
          { title: '结束', dataIndex: 'finished_at', width: 150, render: formatChinaTime },
          {
            title: '操作',
            render: (_: unknown, j: IngestJob) => (
              <Button
                size="small"
                disabled={j.status !== 'FAILED'}
                loading={retry.isPending && retry.variables === j.job_id}
                onClick={() => retry.mutate(j.job_id)}
              >
                重跑
              </Button>
            ),
          },
        ]}
      />
    </PageContainer>
  );
}

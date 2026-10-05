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
        rowKey="job_id"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          { title: 'Job ID', dataIndex: 'job_id' },
          {
            title: '来源',
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
          { title: '更新', dataIndex: 'updated_rows' },
          { title: '跳过', dataIndex: 'skipped_rows' },
          { title: 'Checkpoint', dataIndex: 'checkpoint_row' },
          { title: '开始', dataIndex: 'started_at' },
          { title: '结束', dataIndex: 'finished_at' },
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

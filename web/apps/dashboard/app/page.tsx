import { KpiCard, IntentBadge } from '@leadops/ui';

async function fetchOverview() {
  return {
    totalLeads: 128_430_912,
    activeToday: 2_314_552,
    highIntent: 184_221,
    conversionRate: 0.0387,
    channelMix: [
      { channel: '抖音', value: 42 },
      { channel: '小红书', value: 23 },
      { channel: '汽车之家', value: 18 },
      { channel: '微信私域', value: 11 },
      { channel: '其他', value: 6 },
    ],
    hotCities: [
      { city: '上海', intent: 'L5' as const, value: 23480 },
      { city: '北京', intent: 'L5' as const, value: 19872 },
      { city: '深圳', intent: 'L4' as const, value: 15230 },
      { city: '广州', intent: 'L4' as const, value: 13891 },
      { city: '杭州', intent: 'L3' as const, value: 11204 },
    ],
  };
}

export default async function DashboardPage() {
  const data = await fetchOverview();
  return (
    <main style={{ padding: 32, minHeight: '100vh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>潜客运营 · 实时经营大屏</h1>
        <span style={{ color: '#8ea3bf' }}>{new Date().toLocaleString('zh-CN')}</span>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <KpiCard title="累计潜客" value={data.totalLeads.toLocaleString()} suffix="人" tone="brand" />
        <KpiCard title="今日活跃" value={data.activeToday.toLocaleString()} suffix="人" tone="info" />
        <KpiCard title="高意向" value={data.highIntent.toLocaleString()} suffix="人" tone="warning" />
        <KpiCard title="转化率" value={(data.conversionRate * 100).toFixed(2)} suffix="%" tone="success" />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div style={{ background: '#111a2e', borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>渠道占比</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.channelMix.map((c) => (
              <li key={c.channel} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
                <span style={{ width: 80 }}>{c.channel}</span>
                <div style={{ flex: 1, background: '#1b2740', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${c.value}%`, height: 10, background: '#3b82f6' }} />
                </div>
                <span style={{ width: 48, textAlign: 'right' }}>{c.value}%</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ background: '#111a2e', borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>Top 城市</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.hotCities.map((c) => (
              <li key={c.city} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #1b2740' }}>
                <span>{c.city}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <IntentBadge level={c.intent} />
                  <span>{c.value.toLocaleString()}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

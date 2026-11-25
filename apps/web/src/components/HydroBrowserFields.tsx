export function HydroBrowserFields({ baseUrl, contestId, apiKey, apiKeyConfigured, eventFeedApiKey, eventFeedApiKeyConfigured,
  onApiKey, onEventFeedApiKey, onBaseUrl, onContestId }: {
  baseUrl: string; contestId: string; apiKey: string; apiKeyConfigured?: boolean;
  eventFeedApiKey: string; eventFeedApiKeyConfigured?: boolean;
  onApiKey: (value: string) => void; onEventFeedApiKey: (value: string) => void;
  onBaseUrl: (value: string) => void; onContestId: (value: string) => void;
}) {
  return <>
    <label>HydroOJ 站点地址<input required maxLength={512} placeholder="https://judge.example.org 或 https://judge.example.org/d/域ID" value={baseUrl} onChange={event => onBaseUrl(event.target.value)} /></label>
    <label>HydroOJ 比赛 ID<input required maxLength={24} pattern="[0-9a-fA-F]{24}" placeholder="比赛链接中 /contest/ 后的 24 位 ID" value={contestId} onChange={event => onContestId(event.target.value.trim())} /></label>
    <label>HydroOJ 监考插件 API-Key<input type="password" autoComplete="new-password" maxLength={2000} value={apiKey} onChange={event => onApiKey(event.target.value)} placeholder={apiKeyConfigured ? '留空保留本场已保存的 API-Key' : '目标 HydroOJ 监考插件配置的 API-Key；编辑时留空保留原 Key'} /></label>
    <label>HydroOJ EventFeed 密钥（可选）<input type="password" autoComplete="new-password" maxLength={2000} value={eventFeedApiKey} onChange={event => onEventFeedApiKey(event.target.value)} placeholder={eventFeedApiKeyConfigured ? '留空保留本场已保存的 EventFeed 密钥' : '只需填写密钥，站点和比赛 ID 使用上方配置；编辑时留空保留原 Key'} /></label>
    <p className="muted">使用与系统评测服务不同的 HydroOJ 站点时，必须填写该站点监考插件的 API-Key；未填写时只能使用系统评测服务同站点的 Key。此 Key 仅用于本场考试。赛制、比赛类型和判题均由 HydroOJ 管理，本平台不读取这些配置，也不在本机判题。</p>
    <p className="muted">EventFeed 密钥用于直播和大屏读取该站点的 CCS EventFeed，只需填写密钥，站点地址和比赛 ID 沿用上方。留空时不单独配置，直播仍按现有兼容配置或监考插件广播读取。</p>
  </>;
}

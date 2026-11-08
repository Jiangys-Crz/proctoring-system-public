export function HydroBrowserFields({ baseUrl, contestId, onBaseUrl, onContestId }: {
  baseUrl: string; contestId: string; onBaseUrl: (value: string) => void; onContestId: (value: string) => void;
}) {
  return <>
    <label>HydroOJ 站点地址<input required maxLength={512} placeholder="https://judge.example.org 或 https://judge.example.org/d/域ID" value={baseUrl} onChange={event => onBaseUrl(event.target.value)} /></label>
    <label>HydroOJ 比赛 ID<input required maxLength={24} pattern="[0-9a-fA-F]{24}" placeholder="比赛链接中 /contest/ 后的 24 位 ID" value={contestId} onChange={event => onContestId(event.target.value.trim())} /></label>
  </>;
}

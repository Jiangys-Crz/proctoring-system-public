import Link from 'next/link';
import { ArrowDownToLine, ArrowRight, Monitor, ShieldCheck } from 'lucide-react';
import { DESKTOP_FIXED_RUNTIME, DESKTOP_MAC_RUNTIME, type DesktopTarget } from '@cwnupaa/proctor-shared';
import { getDesktopReleases } from '@/lib/desktop-releases';
import { PublicSiteHeader, PublicSiteFooter } from '@/components/PublicSiteHeader';
import styles from './downloads.module.css';
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [legacy, windowsNative, macNative] = await Promise.all([
    getDesktopReleases().catch(() => []),
    getDesktopReleases(undefined, DESKTOP_FIXED_RUNTIME, false).catch(() => []),
    getDesktopReleases(undefined, DESKTOP_MAC_RUNTIME, false).catch(() => []),
  ]);
  const windowsTargets = [
    { target: 'windows', label: 'Windows 合并版' },
  ] as const satisfies ReadonlyArray<{ target: DesktopTarget; label: string }>;
  const windowsDownloads = windowsTargets.flatMap(({ target, label }) => {
    const release = windowsNative.find(item => item.target === target) ?? legacy.find(item => item.target === target);
    return release ? [{ release, label }] : [];
  });
  const macTargets = ['mac-arm64', 'mac-x64'] as const satisfies readonly DesktopTarget[];
  const macs = macTargets.flatMap(target => {
    const release = macNative.find(item => item.target === target) ?? legacy.find(item => item.target === target);
    return release ? [release] : [];
  });
  return <div className={styles.page}>
    <PublicSiteHeader active="download" />
    <main className={styles.main}>
      <div className={styles.eyebrow}><ShieldCheck size={16} /> CWNU PAA · 通用客户端下载</div>
      <h1>做好准备，<br /><span>安心参加每一场考试。</span></h1>
      <Link href="/test" className={styles.testLink}>参加系统测试考试 <ArrowRight size={16} /><small>随时开放 · 每次 30 分钟</small></Link>
      <div className={styles.cards}>
        <section className={styles.card}>
          <div className={styles.platformIcon} aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M17.1 12.7c0-2 1.6-3 1.7-3.1-.9-1.3-2.3-1.5-2.8-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.5-.7-2.5-.7-1.3 0-2.4.7-3.1 1.8-1.3 2.2-.3 5.5.9 7.3.6.9 1.2 1.8 2.2 1.7.9 0 1.3-.5 2.4-.5s1.4.5 2.4.5 1.5-.9 2.1-1.7c.7-1 1-1.9 1-2-.1 0-1.3-.5-1.3-2.4ZM15.2 6.8c.5-.7.9-1.5.8-2.4-.8 0-1.8.6-2.4 1.3-.5.6-.9 1.5-.8 2.3.9.1 1.8-.5 2.4-1.2Z" /></svg></div>
          <h2>Mac 版</h2><p>适用于 macOS</p>
          <div className={styles.downloads}>{macs.length ? macs.map(release => <a key={release.target} href={release.installer.url} className={styles.download}><ArrowDownToLine size={18} />下载 {release.target === 'mac-arm64' ? 'Apple 芯片版' : 'Intel 版'}<small>v{release.version}</small></a>) : <div className={styles.unavailable}>安装包尚未发布</div>}</div>
          <span className={styles.detail}>请按你的 Mac 芯片类型选择</span>
        </section>
        <section className={styles.card}>
          <div className={styles.platformIcon} aria-hidden="true"><svg viewBox="0 0 24 24" width="29" height="29" fill="currentColor"><path d="M2 4.7 10.6 3.5v7.9H2zm10-1.4L22 2v9.4H12zM2 12.8h8.6v7.8L2 19.4zm10 0h10V22l-10-1.3z" /></svg></div>
          <h2>Windows 版</h2><p>适用于 Windows 电脑</p>
          <div className={styles.downloads}>{windowsDownloads.length ? windowsDownloads.map(({ release, label }) => <a key={release.target} href={release.installer.url} className={styles.download}><ArrowDownToLine size={18} />下载 {label}<small>v{release.version}</small></a>) : <div className={styles.unavailable}>安装包尚未发布</div>}</div>
          <span className={styles.detail}>安装时自动选择 x86、x64 或 ARM64，无需区分架构下载。</span>
        </section>
      </div>
      <div className={styles.steps}><span><b>01</b> 下载并安装</span><span><b>02</b> 完成权限检查</span><span><b>03</b> 登录参加考试</span></div>
      <div className={styles.tip}><Monitor size={18} /><p>建议提前安装并完成测试。客户端会检查最新版本，更新完成后再进入考试。</p></div>
    </main>
    <PublicSiteFooter />
  </div>;
}

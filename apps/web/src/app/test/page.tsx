import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import PublicTestEnrollment from '@/components/PublicTestEnrollment';
import { PublicSiteHeader, PublicSiteFooter } from '@/components/PublicSiteHeader';
import styles from './test.module.css';

export const metadata = { title: '系统测试考试 | CWNU PAA 线上监考' };
export default function TestPage() {
  return <div className={styles.shell}>
    <PublicSiteHeader active="test" />
    <main className={styles.page}>
      <header><div className={styles.tag}><ShieldCheck size={16} />公开体验 · 随时参加</div><h1>正式考试前，先体验一次。</h1><p>使用协会官网账号验证后领取永久测试账号。下载客户端并用手机扫码，<br />即可完整体验设备检查、监考、答题和断网重连。</p></header>
      <PublicTestEnrollment />
      <section className={styles.instructions}><h2>开始之前</h2><ol><li>从<Link href="/">下载主页</Link>安装最新版监考客户端，内网环境使用内网主页的安装包。</li><li>完成摄像头、麦克风和屏幕采集权限检查，在登录页面选择“二维码登录”，用手机扫码或输入配对码，并填写领取的账号。</li><li>体验时间为 30 分钟，支持主动结束。必须准备一部能访问当前监考后台的手机作为第二机位。</li></ol></section>
    </main>
    <PublicSiteFooter />
  </div>;
}

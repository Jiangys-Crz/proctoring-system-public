import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import styles from './PublicSiteHeader.module.css';

export function PublicSiteHeader({ active }: { active: 'download' | 'test' | 'guide' }) {
  const links = [
    { key: 'download', label: '下载', href: '/' },
    { key: 'test', label: '测试', href: '/test' },
    { key: 'guide', label: '指南', href: '/guide' },
  ] as const;
  return <header className={styles.header}>
    <div className={styles.inner}>
      <Link href="/" className={styles.brand}><img src="/brand/logo.png" width={42} height={42} alt="西华师范大学" /><span>程序设计算法协会<small>线上监考平台</small></span></Link>
      <nav className={styles.navigation} aria-label="网站导航">{links.map(link => <Link key={link.key} href={link.href} className={active === link.key ? styles.active : ''} aria-current={active === link.key ? 'page' : undefined}>{link.label}</Link>)}</nav>
      <Link href="/login" className={styles.login}>登录系统 <ArrowUpRight size={16} /></Link>
    </div>
  </header>;
}

export function PublicSiteFooter() {
  return <footer className={styles.footer}>西华师范大学程序设计算法协会 <span>·</span> CWNU PAA</footer>;
}

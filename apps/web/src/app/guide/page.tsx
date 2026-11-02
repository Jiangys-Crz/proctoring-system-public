import { readFileSync } from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import type { Metadata } from 'next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronRight, Monitor, Play, ShieldCheck } from 'lucide-react';
import { PublicSiteHeader, PublicSiteFooter } from '@/components/PublicSiteHeader';
import { GuideImage } from '@/components/GuideImage';
import styles from './guide.module.css';

export const dynamic = 'force-static';
export const metadata: Metadata = {
  title: '安装使用指南 | CWNU PAA 线上监考',
  description: 'Windows 与 Mac 监考客户端安装、系统权限授权及测试账号扫码登录图文指南。',
};

const chapters = [
  { id: 'windows', label: 'Windows 安装与启动', platform: 'WINDOWS', description: '下载安装 · 管理员启动', icon: Monitor },
  { id: 'macos', label: 'Mac 安装与授权', platform: 'MACOS', description: '安装客户端 · 系统权限', icon: ShieldCheck },
  { id: 'test-login', label: '登录测试流程', platform: 'TEST', description: '领取账号 · 手机扫码', icon: Play },
];

export default function GuidePage() {
  const markdown = readFileSync(path.join(process.cwd(), 'src/content/installation-guide.md'), 'utf8');
  const sections = markdown.split(/^## /m).slice(1).map(section => section.slice(section.indexOf('\n') + 1).trim());
  return <div id="guide-top" className={styles.page}>
    <PublicSiteHeader active="guide" />
    <main className={styles.main}>
      <section className={styles.hero}>
        <div><span className={styles.eyebrow}><BookOpen size={15} />安装与使用指南</span><h1>准备好设备，<br /><span>安心进入考试。</span></h1><p>从客户端安装、权限设置，到测试账号登录。<br />跟着图文步骤，完成考前准备。</p><div className={styles.heroLinks}><Link href="/"><ArrowDownToLine size={16} />下载客户端</Link><Link href="/test">领取测试账号 <ArrowRight size={16} /></Link></div></div>
        <div className={styles.preparation}><span className={styles.preparationLabel}>考前准备 · 三步就绪</span>{['下载对应的客户端', '完成安装与系统授权', '领取账号，扫码测试'].map((label, index) => <div key={label}><span>0{index + 1}</span><strong>{label}</strong><Check size={16} /></div>)}<p><ShieldCheck size={14} />建议在正式考试前完成一次测试</p></div>
      </section>
      <div className={styles.quickLinks}>{chapters.map(chapter => <a key={chapter.id} href={`#${chapter.id}`}><span className={styles.chapterIcon}><chapter.icon size={22} /></span><span><strong>{chapter.label}</strong><small>{chapter.description}</small></span><ChevronRight size={17} /></a>)}</div>
      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="指南目录"><span className={styles.tocTitle}>本页目录</span><nav>{chapters.map((chapter, index) => <a href={`#${chapter.id}`} key={chapter.id}><span>0{index + 1}</span>{chapter.label}<ChevronRight size={14} /></a>)}</nav><div className={styles.sidebarNote}><BookOpen size={18} /><strong>按你的设备开始</strong><p>Windows 用户阅读第一章；Mac 用户阅读第二章。安装完成后，继续查看登录测试流程。</p></div><a href="#guide-top" className={styles.backToTop}>返回顶部 ↑</a></aside>
        <div className={styles.chapters}>{chapters.map((chapter, index) => <section id={chapter.id} key={chapter.id} className={styles.chapter}>
          <header className={styles.chapterHeader}><span className={styles.chapterNumber}>0{index + 1}</span><div><span>{chapter.platform}</span><h2>{chapter.label}</h2></div><span className={styles.stepCount}>{(sections[index].match(/^### /gm) || []).length} 个步骤</span></header>
          <div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            h3: ({ children }) => { const label = String(children); const number = label.match(/^(\d+) /)?.[1]; return <h3>{number ? <span className={styles.stepNumber}>{number}</span> : null}{number ? label.slice(number.length + 1) : children}</h3>; },
            a: ({ href, children }) => href?.startsWith('/') ? <Link href={href}>{children}</Link> : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
            img: ({ src, alt }) => <GuideImage src={String(src || '')} alt={alt || '操作示意图'} />,
            p: ({ node, children }) => node?.children.some(child => child.type === 'element' && child.tagName === 'img') ? <div className={styles.imageRow}>{children}</div> : <p>{children}</p>,
          }}>{sections[index]}</ReactMarkdown></div>
        </section>)}
          <section className={styles.finish}><span><Check size={22} /></span><div><h2>安装完成，开始一次测试。</h2><p>提前熟悉登录和监考流程，让正式考试更从容。</p></div><Link href="/test">领取测试账号 <ArrowRight size={17} /></Link></section>
        </div>
      </div>
    </main>
    <PublicSiteFooter />
  </div>;
}

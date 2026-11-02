'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = readonly [href: string, label: string, description?: string];

function isNavActive(pathname: string, href: string) {
  if (href === '/dashboard/exams') return (pathname === href || pathname === `${href}/new` || /^\/dashboard\/exams\/[^/]+(?:\/.*)?$/.test(pathname)) && !/^\/dashboard\/exams\/[^/]+\/(?:status|login|qa|monitor)(?:\/.*)?$/.test(pathname);
  if (href === '/dashboard/monitor') {
    return pathname === href
      || pathname.startsWith(`${href}/`)
      || /^\/dashboard\/exams\/[^/]+\/(?:status|login|qa|monitor)(?:\/.*)?$/.test(pathname);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function HydroNav({ items }: { items: ReadonlyArray<NavItem> }) {
  const pathname = usePathname() || '';
  return <nav className="hydro-nav" aria-label="主导航">
    {items.map(([href, label, description]) => {
      const active = isNavActive(pathname, href);
      return <Link key={href} href={href} title={description} className={active ? 'hydro-nav-active' : ''}>{label}</Link>;
    })}
  </nav>;
}

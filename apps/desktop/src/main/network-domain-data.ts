import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export type DomainSource = 'HTTP' | 'TLS SNI' | 'DNS 查询' | 'DNS 缓存新增';
export interface DomainObservation { domain: string; source: DomainSource }

export function normalizeDomain(input: string): string {
  const domain = domainToASCII(input.trim().replace(/\.$/, '').toLowerCase());
  if (!domain || domain.length > 253 || isIP(domain) || !domain.includes('.')) return '';
  if (!domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  if (domain.endsWith('.arpa') || domain.endsWith('.local') || domain.endsWith('.localhost')) return '';
  return domain;
}

export function parseDnsCapture(line: string): DomainObservation[] {
  // tcpdump query output, including HTTPS/SVCB. Never interpret response IPs or PTR names as visits.
  return [...line.matchAll(/\b(?:A|AAAA|HTTPS|SVCB)\?\s+([^\s]+)/g)]
    .map((match) => ({ domain: normalizeDomain(match[1]), source: 'DNS 查询' as const }))
    .filter((entry) => entry.domain);
}

export function parseTsharkDomains(line: string): DomainObservation[] {
  const fields = line.replace(/\r?\n$/, '').split('\t');
  const sources: DomainSource[] = ['DNS 查询', 'TLS SNI', 'HTTP'];
  return sources.flatMap((source, index) => (fields[index] || '').split(',').map((value) => ({
    domain: normalizeDomain(source === 'HTTP' ? value.replace(/:\d+$/, '') : value), source
  }))).filter((entry) => entry.domain);
}

export function parseWindowsDnsCache(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map((line) => {
    const separator = line.indexOf(':');
    return separator >= 0 ? normalizeDomain(line.slice(separator + 1).trim()) : '';
  }).filter(Boolean))];
}

export class DomainWindow {
  private entries = new Map<string, DomainObservation & { at: number }>();
  clear() { this.entries.clear(); }
  add(observations: DomainObservation[], now = Date.now()) {
    for (const entry of observations) {
      const domain = normalizeDomain(entry.domain);
      if (!domain) continue;
      const key = `${entry.source}:${domain}`;
      this.entries.delete(key);
      this.entries.set(key, { ...entry, domain, at: now });
    }
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value!);
  }
  snapshot(allowedHosts: string[], now = Date.now()): string[] {
    const allowed = new Set(allowedHosts.map((host) => {
      try { return normalizeDomain(new URL(host.includes('://') ? host : `https://${host}`).hostname); }
      catch { return ''; }
    }));
    for (const [key, entry] of this.entries) if (now - entry.at > 30000) this.entries.delete(key);
    return [...this.entries.values()].filter((entry) => !allowed.has(entry.domain))
      .sort((a, b) => b.at - a.at).slice(0, 40)
      .map((entry) => `${entry.domain}（${entry.source}）`);
  }
}

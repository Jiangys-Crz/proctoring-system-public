import { z } from 'zod';
import type { HydroConnectionSettings } from './hydro-settings-contract';

const PluginConfigSchema = z.object({
  problemDomainId: z.string().min(1).max(100),
  authMode: z.string().max(32).optional(),
  configured: z.boolean(),
  pluginVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});

export interface ConnectionCheckItem {
  label: string;
  matched: boolean | null;
  message: string;
}

export interface HydroConnectionCheckResult {
  matched: boolean;
  checks: ConnectionCheckItem[];
}

/** Verify the values currently entered by an administrator without saving or
 * creating domains, users, login tickets, problems, or judge submissions. */
export async function checkHydroConnection(settings: HydroConnectionSettings): Promise<HydroConnectionCheckResult> {
  if (!settings.apiKey) throw new Error('请先填写 API-Key');
  const body = '{}';
  let response: Response;
  try {
    response = await fetch(new URL('/api/proctor/config-check', settings.baseUrl), {
      method: 'POST', body, redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-proctor-api-key': settings.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('无法连接评测服务，请检查主地址、网络和服务是否已启动');
  }
  if (response.status === 401 || response.status === 403) throw new Error('连接认证失败，请确认两端的 API-Key 一致');
  if (response.status === 404) throw new Error('评测服务未启用配置检测接口，请更新并启用监考平台插件');
  if (!response.ok) throw new Error(`评测服务配置检测失败（${response.status}），请检查插件配置和服务日志`);
  const result = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; problemDomainId?: unknown } | null;
  const parsed = PluginConfigSchema.safeParse(result?.data ?? result);
  if (!result?.ok || !parsed.success) throw new Error('评测服务返回的配置检测结果无效，请检查服务主地址及正在启用的插件目录');
  const remote = parsed.data;
  const compare = (label: string, expected: string, actual: string): ConnectionCheckItem => ({
    label, matched: expected === actual,
    message: expected === actual ? '两端一致' : `网页填写：${expected}；服务配置：${actual || '未填写'}`,
  });
  const checks: ConnectionCheckItem[] = [
    { label: 'API-Key', matched: true, message: 'API-Key 认证通过' },
    compare('题库域 ID', settings.problemDomainId, remote.problemDomainId),
  ];
  if (!remote.configured) checks.push({ label: '插件配置', matched: false, message: '评测插件尚未完成配置，请在评测服务中保存 API-Key 后重试' });
  if (remote.authMode !== 'api-key') checks.push({ label: '插件版本', matched: false, message: '评测服务仍返回旧插件配置，无法确认仅 API-Key 判题。请覆盖 Hydro 当前启用的监考插件目录并重启 Hydro；无需填写旧签名或账号字段' });
  else if (remote.pluginVersion) checks.push({ label: '插件版本', matched: true, message: `已加载 ${remote.pluginVersion}，使用 API-Key 认证` });
  return { matched: checks.every(item => item.matched !== false), checks };
}

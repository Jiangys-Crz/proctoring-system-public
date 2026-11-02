export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.message || '服务暂不可用，请稍后再试');
  }
  return body.data as T;
}

export function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback = '') {
  return process.env[name] || fallback;
}

export function appBaseUrl() {
  return optionalEnv('APP_BASE_URL', 'http://localhost:4031').replace(/\/$/, '');
}

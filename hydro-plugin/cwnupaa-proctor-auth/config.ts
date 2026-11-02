export const PROCTOR_PLUGIN_VERSION = '0.2.1';
export const PROCTOR_SETTING_PREFIX = 'cwnupaaProctor';
export const DEFAULT_SECRET = 'PLEASE_SET_HYDRO_PROCTOR_SHARED_SECRET';
export const DEFAULT_API_KEY = 'PLEASE_SET_HYDRO_PROCTOR_API_KEY';

export type DisplayRule = 'acm' | 'oi' | 'ioi';
export interface RuleMapping {
    hydroRule: string;
    displayRule: DisplayRule;
}

export const DEFAULT_RULE_MAPPINGS: RuleMapping[] = [
    { hydroRule: 'acm', displayRule: 'acm' },
    { hydroRule: 'oi', displayRule: 'oi' },
    { hydroRule: 'ioi', displayRule: 'ioi' },
    { hydroRule: 'strictioi', displayRule: 'ioi' },
    { hydroRule: 'ledo', displayRule: 'ioi' },
    { hydroRule: 'homework', displayRule: 'oi' },
];

export interface ProctorConfig {
    sharedSecret: string;
    apiKey: string;
    websiteUrl: string;
    ticketTtlSeconds: number;
    domainId: string;
    problemDomainId: string;
    ownerUid: number;
    judgeAccount: string;
    judgePassword: string;
    allowedRedirectPrefix: string;
    ruleMappings: RuleMapping[];
}

export const DEFAULT_CONFIG: ProctorConfig = {
    sharedSecret: DEFAULT_SECRET,
    apiKey: DEFAULT_API_KEY,
    websiteUrl: '',
    ticketTtlSeconds: 120,
    domainId: 'system',
    problemDomainId: 'Problems',
    ownerUid: 1,
    judgeAccount: 'proctor-judge',
    judgePassword: '',
    allowedRedirectPrefix: '/contest/',
    ruleMappings: DEFAULT_RULE_MAPPINGS,
};

export class ProctorConfigError extends Error {
    constructor(public readonly key: string, message: string) {
        super(message);
        this.name = 'ProctorConfigError';
    }
}

export function proctorSettingKey(key: string) {
    return `${PROCTOR_SETTING_PREFIX}.${key}`;
}

function integer(value: unknown, key: string, min: number, max: number) {
    const parsed = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new ProctorConfigError(proctorSettingKey(key), `请输入 ${min} 至 ${max} 的整数`);
    }
    return parsed;
}

function domain(value: unknown, key: string) {
    const parsed = String(value ?? '').trim();
    if (!parsed || parsed.length > 100 || /[\s/\\?#\u0000-\u001f\u007f-\u009f]/.test(parsed)) {
        throw new ProctorConfigError(proctorSettingKey(key), '域 ID 不能为空，且不能包含空白或路径字符');
    }
    return parsed;
}

function rules(value: unknown): RuleMapping[] {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch {
            throw new ProctorConfigError(proctorSettingKey('ruleMappings'), '赛制映射必须为合法的 JSON 数组');
        }
    }
    if (!Array.isArray(parsed) || parsed.length > 100) {
        throw new ProctorConfigError(proctorSettingKey('ruleMappings'), '赛制映射必须为 JSON 数组，最多 100 项');
    }
    const seen = new Set<string>();
    return parsed.map((item) => {
        const hydroRule = typeof item?.hydroRule === 'string' ? item.hydroRule.trim().toLowerCase() : '';
        const displayRule = item?.displayRule;
        if (!hydroRule || hydroRule.length > 100 || !['acm', 'oi', 'ioi'].includes(displayRule) || seen.has(hydroRule)) {
            throw new ProctorConfigError(proctorSettingKey('ruleMappings'), '每项需填写唯一 hydroRule，displayRule 只能为 acm、oi 或 ioi');
        }
        seen.add(hydroRule);
        return { hydroRule, displayRule };
    });
}

/** Read Hydro's live cache on each request; only absent system settings fall back to the old plugin config. */
export function resolveProctorConfig(readSystem: (key: string) => unknown, legacy: ProctorConfig = DEFAULT_CONFIG): ProctorConfig {
    const get = (key: string, oldKey: keyof ProctorConfig = key as keyof ProctorConfig) => {
        const current = readSystem(proctorSettingKey(key));
        return current === undefined || current === null ? legacy[oldKey] : current;
    };
    // Kept only for existing contest-page CORS behavior. Backend-to-Hydro judge requests need no site address.
    const websiteUrl = legacy.websiteUrl || '';
    const allowedRedirectPrefix = String(get('allowedRedirectPrefix') ?? '').trim();
    if (!allowedRedirectPrefix.startsWith('/') || allowedRedirectPrefix.startsWith('//') || /[\\\0]/.test(allowedRedirectPrefix)) {
        throw new ProctorConfigError(proctorSettingKey('allowedRedirectPrefix'), '跳转前缀须为站内绝对路径，例如 /contest/');
    }
    const judgeAccount = String(get('judgeUsername', 'judgeAccount') ?? '').trim();
    return {
        sharedSecret: String(get('sharedSecret') ?? ''),
        apiKey: String(get('apiKey') ?? ''),
        websiteUrl,
        ticketTtlSeconds: integer(get('ticketTtlSeconds'), 'ticketTtlSeconds', 5, 3600),
        domainId: domain(get('domainId'), 'domainId'),
        problemDomainId: domain(get('problemDomainId'), 'problemDomainId'),
        ownerUid: integer(get('ownerUid'), 'ownerUid', 1, 2147483647),
        judgeAccount,
        // Retained solely for old plugin configuration compatibility. Signed judge requests do not use this password.
        judgePassword: legacy.judgePassword || '',
        allowedRedirectPrefix,
        ruleMappings: rules(get('ruleMappings')),
    };
}

/** Hydro posts dotted form keys as a two-level object; blank secret inputs mean "not changed". */
export function proctorSettingsFromForm(args: Record<string, unknown>): Record<string, unknown> {
    const updates: Record<string, unknown> = {};
    const nested = args[PROCTOR_SETTING_PREFIX];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const [key, value] of Object.entries(nested)) updates[proctorSettingKey(key)] = value;
    }
    for (const [key, value] of Object.entries(args)) {
        if (key.startsWith(`${PROCTOR_SETTING_PREFIX}.`)) updates[key] = value;
    }
    for (const key of ['apiKey', 'sharedSecret']) {
        if (!updates[proctorSettingKey(key)]) delete updates[proctorSettingKey(key)];
    }
    return updates;
}

export function publicProctorConfig(config: ProctorConfig) {
    return {
        problemDomainId: config.problemDomainId,
        authMode: 'api-key',
        pluginVersion: PROCTOR_PLUGIN_VERSION,
        configured: Boolean(config.apiKey && config.apiKey !== DEFAULT_API_KEY),
    };
}

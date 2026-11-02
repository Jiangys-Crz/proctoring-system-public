import { Context, SettingModel, SystemModel, Types, ValidationError } from 'hydrooj';
import {
    ProctorConfig, ProctorConfigError, proctorSettingKey, proctorSettingsFromForm, resolveProctorConfig,
} from './config';

const FAMILY = 'setting_cwnupaa_proctor';

export function registerProctorSystemSettings(ctx: Context, legacy: ProctorConfig) {
    ctx.i18n.load('zh', { [FAMILY]: '考试监考平台' });
    ctx.i18n.load('en', { [FAMILY]: 'Exam Proctoring Platform' });
    const setting = (key: string, value: unknown, type: Parameters<typeof SettingModel.Setting>[3], name: string, desc: string, flag = 0) =>
        SettingModel.Setting(FAMILY, proctorSettingKey(key), value, type, name, desc, flag);
    ctx.effect(() => SettingModel.SystemSetting(
        setting('apiKey', '', 'password', 'API-Key', '先在监考网页后台“评测服务设置”生成并保存 API-Key，再复制粘贴到此处。须与网页完全一致；留空表示保持原值。', SettingModel.FLAG_SECRET),
        setting('problemDomainId', legacy.problemDomainId, 'text', '题库域 ID', '须与网页后台“评测服务设置”的同名字段完全一致。默认 Problems；更改后使用新域，不会迁移旧题目或记录。'),
    ));
    // Native SystemSettingHandler converts primitive types but does not run setting.validation.
    // Validate this plugin's submitted values before any of the setting page's writes occur.
    ctx.on('handler/before/SystemSetting', (handler) => {
        if (String(handler.request.method).toLowerCase() !== 'post') return;
        const updates = proctorSettingsFromForm(handler.args || {});
        if (!Object.keys(updates).length) return;
        try {
            const candidate = resolveProctorConfig((key) => Object.hasOwn(updates, key) ? updates[key] : SystemModel.get(key), legacy);
            const validateName = (Types.Name as readonly any[])[1];
            for (const [key, value] of [
                ['problemDomainId', candidate.problemDomainId],
            ]) {
                if (value && !validateName(value)) throw new ProctorConfigError(proctorSettingKey(key), '名称不符合 Hydro Name 格式');
            }
        } catch (error) {
            if (error instanceof ProctorConfigError) throw new ValidationError(error.key, null, error.message);
            throw error;
        }
    });
}

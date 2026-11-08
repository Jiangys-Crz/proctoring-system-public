/** Shared authoring contract. Keep this module browser-safe: no credentials or I/O. */
export type QuestionKind = 'single' | 'multiple' | 'boolean' | 'fill';
export type AuthoringOption = { id: string; content: string };
export type AuthoringQuestion = { id: string; kind: QuestionKind; content: string; score: number; options: AuthoringOption[]; answers: string[]; answerText: string; partialCredit?: boolean };
export type AuthoringTest = { id: string; input: string; output: string; emptyInput: boolean; emptyOutput: boolean; score: number };
export type ProblemDraft = { kind: 'objective'; title: string; questions: AuthoringQuestion[] }
    | { kind: 'programming'; title: string; content: string; timeMs: number; memoryMb: number; tests: AuthoringTest[] };
export type AuthoringIssue = { path: string; message: string };
export const AUTHORING_LIMITS = { items: 200, options: 26, score: 100, total: 100000, text: 200000, optionText: 20000, testText: 1024 * 1024 } as const;
export const questionKindLabel = { single: '单选题', multiple: '多选题', boolean: '判断题', fill: '填空题' };
export const programmingStatementTemplate = '## 题目描述\n\n\n## 输入格式\n\n\n## 输出格式\n\n\n## 输入输出样例\n\n```input1\n\n```\n\n```output1\n\n```\n\n## 说明与提示\n\n';
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const control = /\{\{\s*(?:select|multiselect|input|textarea)\s*\(/;
function closedCodeFences(text: string) {
    let open: string | undefined;
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!marker) continue;
        if (!open) open = marker[1];
        else if (marker[1][0] === open[0] && marker[1].length >= open.length && !marker[2].trim()) open = undefined;
    }
    return !open;
}
export function validateProblemDraft(value: unknown): AuthoringIssue[] {
    const issues: AuthoringIssue[] = [], add = (path: string, message: string) => issues.push({ path, message });
    if (!record(value)) return [{ path: '', message: '题目内容格式无效' }];
    const text = (v: unknown, path: string, label: string, max: number) => {
        if (typeof v !== 'string' || !v.trim()) add(path, `请填写${label}`);
        else if (v.length > max) add(path, `${label}不能超过 ${max} 个字符`);
        else if (control.test(v)) add(path, `${label}包含保留的作答控件语法，请将示例中的花括号转义`);
    };
    const score = (v: unknown, path: string) => { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > AUTHORING_LIMITS.score) add(path, '分值须为 1～100 的整数，与当前 Hydro 配置编辑器一致'); };
    text(value.title, 'title', '题目名称／题组标题', 200);
    let total = 0;
    if (value.kind === 'objective') {
        if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > AUTHORING_LIMITS.items) return [...issues, { path: 'questions', message: '题组须包含 1～200 个小题' }];
        const ids = new Set<string>();
        value.questions.forEach((q: unknown, i: number) => {
            const p = `questions.${i}`, label = `小题 ${i + 1}`;
            if (!record(q)) { add(p, `${label}格式无效`); return; }
            if (!identity(q.id) || ids.has(q.id)) add(`${p}.id`, `${label}内部编号重复或无效`); else ids.add(q.id);
            if (!['single', 'multiple', 'boolean', 'fill'].includes(q.kind)) add(`${p}.kind`, `${label}题型无效`);
            text(q.content, `${p}.content`, `${label}题目描述`, AUTHORING_LIMITS.text);
            if (typeof q.content === 'string' && !closedCodeFences(q.content)) add(`${p}.content`, `${label}代码块未闭合，会影响后续作答控件，请补齐代码块结束标记`);
            score(q.score, `${p}.score`); if (Number.isFinite(q.score)) total += q.score;
            if (q.kind === 'single' || q.kind === 'multiple') {
                if (q.kind === 'multiple' && q.partialCredit !== undefined && typeof q.partialCredit !== 'boolean') {
                    add(`${p}.partialCredit`, `${label}的部分分设置无效`);
                }
                if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > AUTHORING_LIMITS.options) { add(`${p}.options`, `${label}须有 2～26 个选项`); return; }
                const optionIds = new Set<string>();
                q.options.forEach((o: unknown, j: number) => {
                    if (!record(o)) { add(`${p}.options.${j}`, `${label}选项格式无效`); return; }
                    if (!identity(o.id) || optionIds.has(o.id)) add(`${p}.options.${j}.id`, `${label}选项内部编号重复或无效`); else optionIds.add(o.id);
                    text(o.content, `${p}.options.${j}.content`, `${label}选项 ${String.fromCharCode(65 + j)}`, AUTHORING_LIMITS.optionText);
                    if (typeof o.content === 'string' && !closedCodeFences(o.content)) add(`${p}.options.${j}.content`, `${label}选项 ${String.fromCharCode(65 + j)}代码块未闭合`);
                });
                if (!Array.isArray(q.answers) || !q.answers.length || (q.kind === 'single' && q.answers.length !== 1)
                    || new Set(q.answers).size !== q.answers.length || q.answers.some((id: unknown) => !identity(id) || !optionIds.has(id))) add(`${p}.answers`, `${label}请选择合法的标准答案，答案不能引用已删除的选项`);
            } else if (q.kind === 'boolean') {
                if (!Array.isArray(q.answers) || q.answers.length !== 1 || !['true', 'false'].includes(q.answers[0])) add(`${p}.answers`, `${label}请设置正确／错误答案`);
            } else if (q.kind === 'fill') {
                if (typeof q.answerText !== 'string' || !q.answerText.length) add(`${p}.answerText`, `${label}请填写标准答案`);
                else if (q.answerText.length > 2000 || /[\r\n]/.test(q.answerText)) add(`${p}.answerText`, `${label}标准答案须为不超过 2000 字符的单行文本`);
                else if (q.answerText.trim() !== q.answerText) add(`${p}.answerText`, `${label}标准答案不能含首尾空白；评测会去除考生答案首尾空白，请明确修改标准答案`);
            }
        });
    } else if (value.kind === 'programming') {
        text(value.content, 'content', '题目描述', AUTHORING_LIMITS.text);
        if (value.content === programmingStatementTemplate) add('content', '请填写实际题目描述，不能只保留初始模板');
        if (!Number.isInteger(value.timeMs) || value.timeMs < 1 || value.timeMs > 60000) add('timeMs', '时间限制须为 1～60000 ms 的整数');
        if (!Number.isInteger(value.memoryMb) || value.memoryMb < 1 || value.memoryMb > 4096) add('memoryMb', '内存限制须为 1～4096 MiB 的整数');
        if (!Array.isArray(value.tests) || !value.tests.length || value.tests.length > AUTHORING_LIMITS.items) return [...issues, { path: 'tests', message: '须包含 1～200 个有效测试点' }];
        const ids = new Set<string>();
        value.tests.forEach((t: unknown, i: number) => {
            const p = `tests.${i}`, label = `测试点 ${i + 1}`;
            if (!record(t)) { add(p, `${label}格式无效`); return; }
            if (!identity(t.id) || ids.has(t.id)) add(`${p}.id`, `${label}内部编号重复或无效`); else ids.add(t.id);
            for (const [key, flag, name] of [['input', 'emptyInput', '输入数据'], ['output', 'emptyOutput', '预期输出']]) {
                if (typeof t[flag] !== 'boolean') add(`${p}.${key}`, `${label}${name}的空内容确认状态无效`);
                if (typeof t[key] !== 'string' || t[key].length > AUTHORING_LIMITS.testText) add(`${p}.${key}`, `${label}${name}须为不超过 1048576 个字符的文本`);
                else if (t[key] === '' && t[flag] !== true) add(`${p}.${key}`, `${label}${name}为空，请勾选“明确使用空内容”`);
                else if (t[key] !== '' && t[flag] === true) add(`${p}.${key}`, `${label}${name}已填写，请取消空内容确认`);
            }
            score(t.score, `${p}.score`); if (Number.isFinite(t.score)) total += t.score;
        });
    } else add('kind', '请选择客观题或编程题');
    if (total > AUTHORING_LIMITS.total) add('total', '总分不能超过当前考试系统支持的 100000 分；系统不会自动缩放分值');
    return issues;
}
export function objectiveQuestionMarkdown(q: AuthoringQuestion, index: number) {
    const kind = q.kind === 'fill' ? 'input' : q.kind === 'multiple' ? 'multiselect' : 'select';
    const options = q.kind === 'fill' ? [] : q.kind === 'boolean' ? ['正确', '错误'] : q.options.map(o => o.content);
    const list = q.kind === 'fill' ? '' : '\n\n' + options.map(text => {
        const [first, ...rest] = text.replace(/\r\n?/g, '\n').split('\n');
        return `- ${first}${rest.map(line => `\n  ${line}`).join('')}`;
    }).join('\n');
    return `## ${index + 1}. ${questionKindLabel[q.kind]}（${q.score} 分）\n\n${q.content}\n\n{{ ${kind}(${index + 1}) }}${list}\n`;
}
export function compileProblemDraft(draft: ProblemDraft) {
    const issues = validateProblemDraft(draft);
    if (issues.length) throw new Error(issues.map(i => i.message).join('；'));
    const files: Array<{ name: string; content: string }> = [];
    let content: string, config: Record<string, unknown>, total = 0;
    if (draft.kind === 'objective') {
        const answers: Record<string, unknown> = {};
        draft.questions.forEach((q, i) => {
            const letters = q.kind === 'fill' ? [] : q.kind === 'boolean' ? [q.answers[0] === 'true' ? 'A' : 'B']
                : q.options.map((o, j) => q.answers.includes(o.id) ? String.fromCharCode(65 + j) : null).filter((v): v is string => v !== null);
            let answer: string | string[] = q.answerText;
            if (q.kind === 'multiple') {
                // Hydro awards partial credit for arrays and compares strings exactly.
                // Both Hydro and Proctor submit choices in option order.
                answer = q.partialCredit === false ? letters.join(',') : letters;
            } else if (q.kind !== 'fill') answer = letters[0];
            answers[String(i + 1)] = [answer, q.score];
            total += q.score;
        });
        content = draft.questions.map(objectiveQuestionMarkdown).join('\n---\n\n');
        config = { type: 'objective', answers };
    } else {
        content = draft.content; // Preserve every input/output byte; never trim test data.
        config = { type: 'default', time: `${draft.timeMs}ms`, memory: `${draft.memoryMb}m`, checker_type: 'default',
            subtasks: draft.tests.map((t, i) => {
                total += t.score;
                files.push({ name: `${i + 1}.in`, content: t.input }, { name: `${i + 1}.out`, content: t.output });
                return { id: i + 1, type: 'sum', score: t.score, cases: [{ input: `${i + 1}.in`, output: `${i + 1}.out`, score: t.score }] };
            }) };
    }
    // JSON is a YAML-compatible document accepted by Hydro's js-yaml loader.
    // Quoting strings also protects answers such as "0", "true", ':', and '#'.
    const configText = JSON.stringify(config, null, 2) + '\n';
    files.push({ name: 'config.yaml', content: configText });
    return { title: draft.title, content, config, configText, files, total };
}

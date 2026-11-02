import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Vendored CommonJS + portable WASM grammars; no platform-specific native addon.
const { Parser, Language } = require('../vendor/web-tree-sitter.cjs');

interface Node {
    id: number; type: string; text: string; startIndex: number; endIndex: number;
    children: Node[]; namedChildren: Node[]; parent: Node | null; hasError: boolean;
    childForFieldName(name: string): Node | null;
    childrenForFieldName(name: string): Node[];
}
interface Binding { name: string; key: string; start: number }
interface Scope { parent: Scope | null; bindings: Map<string, Binding[]>; node: Node }
export interface Token { key: string; start: number; end: number; line: number; column: number; endLine: number; endColumn: number }

const grammarNames: Record<string, string> = {
    c: 'c', cpp: 'cpp', python3: 'python', java: 'java', javascript: 'javascript',
    typescript: 'typescript', golang: 'go', rust: 'rust', csharp: 'c-sharp', kotlin: 'kotlin',
};
export const parserFiles = ['web-tree-sitter.wasm', ...Object.values(grammarNames).map((name) => `tree-sitter-${name}.wasm`)];
let initialized: Promise<void> | undefined;
const languages = new Map<string, any>();

const isName = (node: Node) => ['identifier', 'field_identifier', 'simple_identifier'].includes(node.type);
const field = (node: Node, name: string) => node.childForFieldName(name);
const functionTypes = new Set([
    'function_definition', 'function_declaration', 'function_expression', 'generator_function_declaration',
    'generator_function', 'arrow_function', 'lambda', 'lambda_expression', 'method_declaration',
    'constructor_declaration', 'function_item', 'closure_expression', 'anonymous_function', 'local_function_statement', 'lambda_literal',
]);
const classTypes = new Set(['class_declaration', 'class_definition', 'class_specifier', 'struct_specifier', 'struct_item']);
const blockTypes = new Set(['compound_statement', 'block', 'statement_block', 'for_statement',
    'for_range_loop', 'enhanced_for_statement', 'for_in_statement', 'for_expression', 'foreach_statement', 'catch_clause']);
const comprehensions = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

function declarators(node: Node | null): Node[] {
    if (!node) return [];
    if (isName(node)) return [node];
    // Function names and typedef/type names remain exact. A function-pointer
    // variable is handled through its parenthesized pointer declarator.
    if (node.type === 'function_declarator') {
        const inner = field(node, 'declarator');
        return inner?.type === 'parenthesized_declarator' ? declarators(inner) : [];
    }
    if (['init_declarator', 'pointer_declarator', 'reference_declarator', 'array_declarator'].includes(node.type)) {
        return declarators(field(node, 'declarator') || node.namedChildren[0]);
    }
    if (['parenthesized_declarator', 'structured_binding_declarator'].includes(node.type)) return node.namedChildren.flatMap(declarators);
    return [];
}

function patternNames(node: Node | null): Node[] {
    if (!node) return [];
    if (isName(node)) return [node];
    // Attributes, subscripts, object keys, type names and default expressions
    // are not variable declarations, even when nested inside a target pattern.
    if (['attribute', 'subscript', 'member_expression', 'field_expression', 'property_identifier',
        'type_identifier', 'shorthand_property_identifier_pattern'].includes(node.type)) return [];
    if (['default_parameter', 'typed_default_parameter', 'assignment_pattern'].includes(node.type)) {
        return patternNames(field(node, 'name') || field(node, 'left'));
    }
    if (['required_parameter', 'optional_parameter', 'typed_parameter'].includes(node.type)) {
        return patternNames(field(node, 'pattern') || field(node, 'name') || node.namedChildren[0]);
    }
    if (node.type === 'pair_pattern' || node.type === 'field_pattern') return patternNames(field(node, 'value') || field(node, 'pattern'));
    if (/^(parameters|formal_parameters|closure_parameters|pattern_list|tuple_pattern|list_pattern|tuple|list|array_pattern|object_pattern|expression_list|tuple_expression|slice_pattern|mut_pattern|reference_pattern|captured_pattern|list_splat_pattern|dictionary_splat_pattern|rest_pattern)$/.test(node.type)) {
        return node.namedChildren.flatMap(patternNames);
    }
    return [];
}

function variableDeclarations(node: Node, language: string): Node[] {
    if (language === 'c' || language === 'cpp') {
        if (['declaration', 'field_declaration', 'parameter_declaration', 'optional_parameter_declaration', 'for_range_loop'].includes(node.type)) {
            return node.childrenForFieldName('declarator').flatMap(declarators);
        }
    }
    if (language === 'python3') {
        if (['assignment', 'augmented_assignment', 'for_statement', 'for_in_clause', 'named_expression'].includes(node.type)) {
            return patternNames(field(node, 'left') || field(node, 'name'));
        }
        if (['function_definition', 'lambda'].includes(node.type)) return patternNames(field(node, 'parameters'));
        if (node.type === 'as_pattern') return patternNames(field(node, 'alias'));
    }
    if (['java', 'javascript', 'typescript', 'csharp'].includes(language)) {
        if (node.type === 'variable_declarator') return patternNames(field(node, 'name'));
        if (['formal_parameter', 'spread_parameter', 'catch_formal_parameter', 'parameter', 'enhanced_for_statement'].includes(node.type)) return patternNames(field(node, 'name'));
        if (node.type === 'foreach_statement') return patternNames(field(node, 'left'));
        if (['javascript', 'typescript'].includes(language)) {
            if (functionTypes.has(node.type) || node.type === 'method_definition') return patternNames(field(node, 'parameters') || field(node, 'parameter'));
            if (node.type === 'for_in_statement') return patternNames(field(node, 'left'));
            if (node.type === 'catch_clause') return patternNames(field(node, 'parameter'));
        }
    }
    if (language === 'golang') {
        if (['var_spec', 'parameter_declaration', 'variadic_parameter_declaration'].includes(node.type)) return node.childrenForFieldName('name').flatMap(patternNames);
        if (['short_var_declaration', 'range_clause'].includes(node.type)) return patternNames(field(node, 'left'));
    }
    if (language === 'rust' && ['let_declaration', 'parameter', 'for_expression', 'closure_parameters'].includes(node.type)) {
        return patternNames(field(node, 'pattern') || (node.type === 'closure_parameters' ? node : null));
    }
    if (language === 'kotlin' && ['variable_declaration', 'parameter', 'class_parameter', 'lambda_parameters'].includes(node.type)) {
        return node.namedChildren.filter((child) => child.type === 'simple_identifier');
    }
    return [];
}

function normalizeBindings(root: Node, language: string) {
    const scopes = new Map<number, Scope>();
    const declarationKeys = new Map<number, string>();
    const module: Scope = { parent: null, bindings: new Map(), node: root };
    let nextKey = 0;
    const visible = (scope: Scope | null, name: string) => {
        while (scope) { const binding = scope.bindings.get(name)?.at(-1); if (binding) return binding; scope = scope.parent; }
        return null;
    };
    const visit = (node: Node, inherited: Scope) => {
        const introduces = functionTypes.has(node.type) || node.type === 'method_definition' || classTypes.has(node.type)
            || (language === 'python3' ? comprehensions.has(node.type) : blockTypes.has(node.type));
        const scope = node !== root && introduces ? { parent: inherited, bindings: new Map(), node } : inherited;
        scopes.set(node.id, scope);
        const declarations = variableDeclarations(node, language);
        if (language === 'cpp' && node.type === 'declaration') {
            for (const declarator of node.childrenForFieldName('declarator')) {
                // The grammar alone cannot distinguish vector<int> a(n) from
                // a function prototype. An already declared variable n makes
                // this a direct initializer; type names still stay exact.
                if (declarator.type !== 'function_declarator') continue;
                const parameters = field(declarator, 'parameters')?.namedChildren || [];
                const arguments_ = parameters.map((parameter) => field(parameter, 'type'));
                if (!parameters.length || parameters.some((parameter) => field(parameter, 'declarator'))
                    || arguments_.some((argument) => !argument || argument.type !== 'type_identifier' || !visible(scope, argument.text))) continue;
                declarations.push(...declarators(field(declarator, 'declarator')));
                for (const argument of arguments_) declarationKeys.set(argument!.id, visible(scope, argument!.text)!.key);
            }
        }
        for (const name of declarations) {
            if (name.text === '_' && ['python3', 'golang', 'rust'].includes(language)) continue;
            const bindings = scope.bindings.get(name.text) || [];
            // Python assignments and Go := may reuse an existing variable. Rust
            // let shadowing intentionally introduces a new binding in one block.
            const binding = language !== 'rust' && bindings.length ? bindings[bindings.length - 1]
                : { name: name.text, key: `variable:${nextKey++}`, start: language === 'rust' && node.type === 'let_declaration' ? node.endIndex : name.startIndex };
            if (!bindings.includes(binding)) bindings.push(binding);
            scope.bindings.set(name.text, bindings);
            declarationKeys.set(name.id, binding.key);
        }
        for (const child of node.children) visit(child, scope);
    };
    visit(root, module);

    const resolve = (node: Node): string | null => {
        if (declarationKeys.has(node.id)) return declarationKeys.get(node.id)!;
        if (!isName(node)) return null;
        const parent = node.parent;
        if (!parent) return null;
        if (functionTypes.has(parent.type) && (field(parent, 'name')
            || (language === 'kotlin' && parent.type === 'function_declaration' ? parent.namedChildren.find(isName) : null))?.id === node.id) return null;
        // Names of functions, methods, imports, labels, attributes and types are
        // exact tokens. Members of unknown objects cannot be resolved locally.
        if ((field(parent, 'name')?.id === node.id && (functionTypes.has(parent.type) || classTypes.has(parent.type)
            || /method|constructor|namespace|import|package|type_alias/.test(parent.type)))
            || field(parent, 'type')?.id === node.id || /label|import|package|namespace/.test(parent.type)) return null;
        if (parent.type === 'keyword_argument' && field(parent, 'name')?.id === node.id) return null;
        // Some grammars wrap a type's name in a generic/qualified node. Never
        // resolve that name as a same-named variable from an enclosing scope.
        let ancestor: Node | null = parent;
        while (ancestor && ancestor !== scopes.get(node.id)?.node) {
            const type = field(ancestor, 'type');
            if (type && node.startIndex >= type.startIndex && node.endIndex <= type.endIndex) return null;
            if (/^(type_annotation|user_type|generic_name|qualified_name|scoped_type_identifier)$/.test(ancestor.type)) return null;
            ancestor = ancestor.parent;
        }
        if (['attribute', 'member_expression', 'field_expression', 'field_access', 'selector_expression', 'navigation_expression'].includes(parent.type)) {
            const member = field(parent, 'field') || field(parent, 'property') || field(parent, 'attribute');
            if (member?.id === node.id) {
                const object = field(parent, 'object') || field(parent, 'argument') || field(parent, 'value');
                if (!object || !['this', 'self'].includes(object.text)) return null;
                // Only normalize an explicit self/this field if its declaration
                // exists in the enclosing class scope, not a same-named local.
                let scope = scopes.get(node.id);
                while (scope && !classTypes.has(scope.node.type)) scope = scope.parent!;
                return scope?.bindings.get(node.text)?.[0]?.key || null;
            }
        }
        let scope = scopes.get(node.id);
        while (scope) {
            const bindings = scope.bindings.get(node.text);
            const available = bindings?.filter((binding) => language === 'python3' || binding.start <= node.startIndex || classTypes.has(scope!.node.type));
            if (available?.length) return available[available.length - 1].key;
            scope = scope.parent!;
        }
        return null;
    };
    return resolve;
}

export async function tokenize(code: string, language: string, parserPath: string): Promise<Token[]> {
    initialized ||= Parser.init({ wasmBinary: await readFile(path.join(parserPath, 'web-tree-sitter.wasm')) });
    await initialized;
    const name = grammarNames[language];
    if (!name) throw new Error('不支持的代码语言');
    if (!languages.has(name)) languages.set(name, await Language.load(await readFile(path.join(parserPath, `tree-sitter-${name}.wasm`))));
    const parser = new Parser();
    parser.setLanguage(languages.get(name));
    const tree = parser.parse(code);
    try {
        if (!tree || tree.rootNode.hasError) throw new Error('代码语法无法解析');
        const resolve = normalizeBindings(tree.rootNode, language);
        const tokens: Token[] = [];
        const lineStarts = [0];
        for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
        const position = (offset: number) => {
            let lo = 0; let hi = lineStarts.length;
            while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid; }
            return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
        };
        const push = (key: string, start: number, end: number) => {
            const first = position(start); const last = position(Math.max(start, end - 1));
            tokens.push({ key, start, end, ...first, endLine: last.line, endColumn: last.column });
        };
        // Only opaque parser leaves (preprocessor arguments, multiword primitive
        // types) need lexical splitting. Strings/comments are kept atomic first.
        const split = (node: Node) => {
            const lexer = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?:u8|[uUL])?"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[\w]*|>>=|<<=|===|!==|->\*|\.\.\.|\*\*=|&&=|\|\|=|\?\?=|==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||<<|>>|->|::|=>|\*\*|[^\s]/gu;
            for (const match of node.text.matchAll(lexer)) {
                if (match[0].startsWith('//') || match[0].startsWith('/*')) continue;
                push(`exact:${match[0]}`, node.startIndex + match.index!, node.startIndex + match.index! + match[0].length);
            }
        };
        const visit = (node: Node) => {
            if (/comment/.test(node.type)) return;
            // Preserve literal spelling including escapes and spaces. Interpolated
            // strings recurse so embedded variable references are still normalized.
            const literal = /^(string|char_literal|character_literal|raw_string_literal|string_literal|interpreted_string_literal)$/.test(node.type);
            const interpolated = literal && (node.namedChildren.some((child) => /interpolation|substitution/.test(child.type)));
            if (literal && !interpolated) { push(`exact:${node.text}`, node.startIndex, node.endIndex); return; }
            if (language === 'python3' && node.type === 'block') push('syntax:indent', node.startIndex, node.startIndex);
            if (!node.children.length) {
                if (node.text.trim()) {
                    const normalized = resolve(node);
                    if (normalized) push(normalized, node.startIndex, node.endIndex);
                    else if (/\s/.test(node.text) && !/string|char/.test(node.type)) split(node);
                    else push(`exact:${node.text}`, node.startIndex, node.endIndex);
                }
            } else for (const child of node.children) visit(child);
            if (language === 'python3' && node.type === 'block') push('syntax:dedent', node.endIndex, node.endIndex);
        };
        visit(tree.rootNode);
        return tokens;
    } finally { tree?.delete(); parser.delete(); }
}

import { getStyles } from './ui-components/styles.js';
import { getHeader } from './ui-components/header.js';
import { getMainPanel } from './ui-components/main-panel.js';
import { getSidebar } from './ui-components/sidebar.js';
import { getFooter } from './ui-components/footer.js';

export function getWidgetHTML() {
    return [
        '',
        getStyles(),
        '',
        '    <div id="specter-outreach-panel">',
        getHeader(),
        '',
        '        <div class="panel-body">',
        '            <div class="panel-scroll">',
        getMainPanel(),
        '',
        getSidebar(),
        '                    </div>',
        '                </section>',
        '            </div>',
        '',
        getFooter(),
        '        </div>',
        '',
        '        <div id="resize-handle"></div>',
        '    </div>',
        '',
    ].join('\n');
}

export function getDefaultModelOptions() {
    return [
        { label: 'OpenAI: GPT-5.1', id: 'openai/gpt-5.1' },
        { label: 'OpenAI: GPT-5', id: 'openai/gpt-5' },
        { label: 'OpenAI: GPT-5 Mini', id: 'openai/gpt-5-mini' },
        { label: 'OpenAI: GPT-OSS', id: 'openai/gpt-oss-120b' },
        { label: 'Google: Gemini 3 Pro', id: 'google/gemini-3-pro-preview' },
        { label: 'Google: Gemini 2.5 Pro', id: 'google/gemini-2.5-pro' },
        { label: 'Google: Gemini 2.5 Flash', id: 'google/gemini-2.5-flash-preview-09-2025' },
        { label: 'Anthropic: Claude Sonnet 4.5', id: 'anthropic/claude-sonnet-4.5' },
        { label: 'Anthropic: Claude Opus 4.5', id: 'anthropic/claude-opus-4.5' },
        { label: 'Grok: Grok 4.1 Fast', id: 'x-ai/grok-4.1-fast' },
        { label: 'Grok: Grok 4', id: 'x-ai/grok-4' },
        { label: 'Grok: Grok 4 Fast', id: 'x-ai/grok-4-fast' },
        { label: 'DeepSeek: V3.2 Exp', id: 'deepseek/deepseek-v3.2-exp' },
        { label: 'DeepSeek: V3.1', id: 'deepseek/deepseek-v3.1-terminus' },
        { label: 'DeepSeek: R1', id: 'deepseek/deepseek-r1-0528' },
        { label: 'Mistral: Mistral Medium 3.1', id: 'mistralai/mistral-medium-3.1' },
        { label: 'Qwen: Qwen3 Max', id: 'qwen/qwen3-max' },
        { label: 'Qwen: Qwen3 235B A22B Thinking', id: 'qwen/qwen3-235b-a22b-thinking-2507' },
        { label: 'Qwen: Qwen3 Plus', id: 'qwen/qwen-plus-2025-07-28:thinking' },
        { label: 'Z AI: GLM 4.6', id: 'z-ai/glm-4.6' },
        { label: 'Z AI: GLM 4.5', id: 'z-ai/glm-4.5' },
        { label: 'MoonshotAI: Kimi K2 Thinking', id: 'moonshotai/kimi-k2-thinking' },
        { label: 'MoonshotAI: Kimi K2', id: 'moonshotai/kimi-k2-0905' },
        { label: 'StepFun: Step3', id: 'stepfun-ai/step3' },
        { label: 'Baidu: ERNIE 4.5', id: 'baidu/ernie-4.5-300b-a47b' },
    ];
}

export function getUIConfig() {
    return {
        defaultModelId: 'deepseek/deepseek-v3.1-terminus',
        modelOptions: getDefaultModelOptions(),
        unipilePollIntervalMs: 5000
    };
}

export function getHeader() {
    return [
        '        <div class="panel-header">',
        '            <div id="dragHandle">',
        '                <div class="panel-heading-text">',
        '                    <span class="panel-title">DN Outreach Copilot</span>',
        '                </div>',
        '            </div>',
        '            <div class="header-actions">',
        '                <label class="model-select">',
        '                    <select id="modelSelect"></select>',
        '                </label>',
        '                <button id="closeBtn" title="Close" type="button">',
        '                    <span aria-hidden="true">×</span>',
        '                    <span class="sr-only">Close widget</span>',
        '                </button>',
        '            </div>',
        '        </div>'
    ].join('\n');
}

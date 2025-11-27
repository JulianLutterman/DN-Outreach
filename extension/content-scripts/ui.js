// content-scripts/ui.js

import { escapeRegExp } from './utils.js';
import { activeFounderContact, companyContext, userInfo } from './state.js';

// widgetHTML is now fetched from backend via /api/ui/widget-html

export function makeResizable(panel) {
    if (!panel) return;
    let rootNode = null;
    if (typeof panel.getRootNode === 'function') {
        rootNode = panel.getRootNode();
    }
    let handle = null;
    if (rootNode && typeof rootNode.getElementById === 'function') {
        handle = rootNode.getElementById('resize-handle');
    }
    if (!handle) {
        handle = panel.querySelector('#resize-handle');
    }
    if (!handle) return;
    let initialWidth, initialHeight, initialMouseX, initialMouseY;
    let hostElement = null;
    let initialHostLeft = null;
    let initialHostRight = null;

    handle.addEventListener('mousedown', function (e) {
        e.preventDefault();

        initialWidth = panel.offsetWidth;
        initialHeight = panel.offsetHeight;
        initialMouseX = e.clientX;
        initialMouseY = e.clientY;
        if (!rootNode || typeof panel.getRootNode !== 'function') {
            if (typeof panel.getRootNode === 'function') {
                rootNode = panel.getRootNode();
            }
        }
        if (rootNode && rootNode.host) {
            hostElement = rootNode.host;
        } else {
            hostElement = panel.parentElement;
        }
        if (hostElement) {
            const hostRect = hostElement.getBoundingClientRect();
            initialHostLeft = hostRect.left;
            initialHostRight = hostRect.right;
        } else {
            initialHostLeft = null;
            initialHostRight = null;
        }

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    });

    function handleMouseMove(e) {
        const deltaX = e.clientX - initialMouseX;
        const deltaY = e.clientY - initialMouseY;

        const cs = getComputedStyle(panel);
        const minW = parseInt(cs.minWidth) || 380;
        const maxW = parseInt(cs.maxWidth) || Math.max(minW, window.innerWidth - 24);
        const minH = parseInt(cs.minHeight) || 520;
        const maxH = parseInt(cs.maxHeight) || Math.max(minH, window.innerHeight - 24);

        const nextWidth = Math.min(Math.max(minW, initialWidth - deltaX), maxW);
        const nextHeight = Math.min(Math.max(minH, initialHeight + deltaY), maxH);

        panel.style.width = nextWidth + 'px';
        panel.style.height = nextHeight + 'px';

        if (hostElement) {
            const maxRight = window.innerWidth - 8;
            const maxBottom = window.innerHeight - 8;
            const minLeft = 8;

            let desiredLeft;
            if (initialHostRight !== null) {
                desiredLeft = initialHostRight - nextWidth;
            } else if (initialHostLeft !== null) {
                desiredLeft = initialHostLeft;
            } else {
                const currentRect = hostElement.getBoundingClientRect();
                desiredLeft = currentRect.right - nextWidth;
            }

            const maxAllowedLeft = maxRight - nextWidth;
            let clampedLeft = Math.min(Math.max(desiredLeft, minLeft), maxAllowedLeft);

            hostElement.style.left = clampedLeft + 'px';
            hostElement.style.right = 'auto';

            let updatedRect = hostElement.getBoundingClientRect();

            if (updatedRect.left < minLeft) {
                hostElement.style.left = minLeft + 'px';
                updatedRect = hostElement.getBoundingClientRect();
            } else if (updatedRect.right > maxRight) {
                const adjustedLeft = Math.max(minLeft, maxRight - updatedRect.width);
                hostElement.style.left = adjustedLeft + 'px';
                updatedRect = hostElement.getBoundingClientRect();
            }

            if (updatedRect.bottom > maxBottom) {
                const overshoot = updatedRect.bottom - maxBottom;
                const adjustedTop = Math.max(8, updatedRect.top - overshoot);
                hostElement.style.top = adjustedTop + 'px';
            }
        }
    }

    function handleMouseUp() {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        hostElement = null;
        initialHostLeft = null;
        initialHostRight = null;
    }
}

export function makeDraggableWithinWindow(root, shadowRoot) {
    if (!root || !shadowRoot) return;
    const panel = shadowRoot.querySelector('#specter-outreach-panel');
    const handle = shadowRoot.querySelector('#dragHandle');
    if (!panel || !handle) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseMove = (event) => {
        if (!dragging) return;
        const panelRect = panel.getBoundingClientRect();
        const newLeft = Math.min(
            Math.max(8, event.clientX - offsetX),
            window.innerWidth - panelRect.width - 8
        );
        const newTop = Math.min(
            Math.max(8, event.clientY - offsetY),
            window.innerHeight - panelRect.height - 8
        );

        root.style.left = newLeft + 'px';
        root.style.top = newTop + 'px';
        root.style.right = 'auto';
    };

    const onMouseUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const rect = root.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        dragging = true;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

export function rememberTemplateBaseline(el, initialCandidate = '') {
    if (!el) return '';
    if (el.dataset && el.dataset.templateBase) {
        return el.dataset.templateBase;
    }
    const candidates = [];
    if (typeof initialCandidate === 'string') candidates.push(initialCandidate);
    if (typeof el.value === 'string') candidates.push(el.value);
    const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
    if (placeholder) candidates.push(placeholder);
    for (const candidate of candidates) {
        if (candidate && candidate.includes('{{')) {
            if (el.dataset) el.dataset.templateBase = candidate;
            return candidate;
        }
    }
    return el.dataset?.templateBase || '';
}

export function autoFillFollowUpMessages(widgetQuery) {
    const firstName = (activeFounderContact?.firstName
        || companyContext?.founder?.firstName
        || '').trim();
    const calendly = widgetQuery('#calendly')?.value?.trim() || '';
    const partnerSelect = widgetQuery('#partnerForwardSelect');
    const option = partnerSelect?.selectedOptions?.[0] || null;
    const partnerName = option && option.value ? String(option.textContent || '').trim() : '';

    const fieldConfigs = [
        {
            el: widgetQuery('#followUpTemplate'),
            placeholders: {
                '{{firstName}}': firstName,
                '{{calendly}}': calendly
            }
        },
        {
            el: widgetQuery('#linkedinMessage'),
            placeholders: {
                '{{firstName}}': firstName
            },
            enforceMaxLength: true
        },
        {
            el: widgetQuery('#partnerMessage'),
            placeholders: {
                '{{partnerName}}': partnerName,
                '{{firstName}}': firstName
            }
        }
    ];

    for (const { el, placeholders, enforceMaxLength } of fieldConfigs) {
        if (!el) continue;
        const templateBase = rememberTemplateBaseline(el);
        if (!templateBase) continue;

        const currentValue = typeof el.value === 'string' ? el.value : '';
        const autoFilledValue = el.dataset?.autoFilledValue || '';
        const shouldUpdate =
            currentValue === autoFilledValue ||
            currentValue === templateBase ||
            currentValue.includes('{{');

        if (!shouldUpdate) continue;

        let output = templateBase;
        let replacedSomething = false;

        for (const [token, value] of Object.entries(placeholders || {})) {
            if (!value) continue;
            if (!output.includes(token)) continue;
            const regex = new RegExp(escapeRegExp(token), 'g');
            output = output.replace(regex, value);
            replacedSomething = true;
        }

        if (!replacedSomething) continue;

        if (enforceMaxLength && typeof el.maxLength === 'number' && el.maxLength > 0 && output.length > el.maxLength) {
            output = output.slice(0, el.maxLength);
        }

        if (output !== currentValue) {
            el.value = output;
        }
        if (el.dataset) {
            el.dataset.autoFilledValue = output;
        }
    }
}

export function updateLoginUI(userName, widgetQuery) {
    if (widgetQuery('#loginBtn')) widgetQuery('#loginBtn').style.display = 'none';
    if (widgetQuery('#logoutBtn')) widgetQuery('#logoutBtn').style.display = 'inline-block';
    if (widgetQuery('#loginStatus')) widgetQuery('#loginStatus').textContent = 'Logged in as ' + userName + '\u00A0\u00A0\u00A0';
    if (widgetQuery('#generateBtn')) widgetQuery('#generateBtn').disabled = false;
}

export function showLoginButton(widgetQuery) {
    if (widgetQuery('#loginBtn')) widgetQuery('#loginBtn').style.display = 'inline-block';
    if (widgetQuery('#logoutBtn')) widgetQuery('#logoutBtn').style.display = 'none';
    if (widgetQuery('#loginStatus')) widgetQuery('#loginStatus').textContent = '';
    if (widgetQuery('#generateBtn')) widgetQuery('#generateBtn').disabled = true;
    if (widgetQuery('#sendBtn')) widgetQuery('#sendBtn').disabled = true;
}

export function setStatus(txt, widgetQuery) {
    const el = widgetQuery('#status');
    if (el) el.textContent = txt;
}

export function updateUnipileButtonState(accountId, widgetQuery, setLinkedInFollowUpAvailability) {
    const btn = widgetQuery('#unipileBtn');
    if (!btn) return;
    const row = btn.closest('.unipile-row');
    const isLoggedIn = !!userInfo;
    console.log('[Unipile][ui] update button state', { accountId, isLoggedIn });

    if (!isLoggedIn) {
        btn.disabled = true;
        btn.textContent = 'Connect LinkedIn (Unipile)';
        btn.style.display = 'none';
        if (row) row.style.display = 'none';
        setLinkedInFollowUpAvailability(false);
        return;
    }

    if (accountId) {
        btn.disabled = true;
        btn.textContent = 'LinkedIn Connected (Unipile)';
        btn.style.display = 'none';
        if (row) row.style.display = 'none';
    } else {
        btn.disabled = false;
        btn.textContent = 'Connect LinkedIn (Unipile)';
        btn.style.display = 'inline-flex';
        if (row) row.style.display = 'flex';
    }
    setLinkedInFollowUpAvailability(!!accountId);
}

export function setLinkedInFollowUpAvailability(isConnected, widgetQuery) {
    const toggle = widgetQuery('#linkedinFollowUpToggle');
    const trigger = widgetQuery('#linkedinTrigger');
    const message = widgetQuery('#linkedinMessage');

    if (toggle) {
        toggle.disabled = !isConnected;
        if (!isConnected && toggle.checked) {
            toggle.checked = false;
        }
    }

    const applyDisabledState = (el) => {
        if (!el) return;
        el.disabled = !isConnected;
    };

    applyDisabledState(trigger);
    applyDisabledState(message);
}

export function formatWorkflowDate(value) {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    if (isNaN(date.getTime())) return value;
    const datePart = date.toLocaleDateString();
    const timePart = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return datePart + ' ' + timePart;
}

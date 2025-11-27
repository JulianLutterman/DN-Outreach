// content-scripts/workflow.js

import { normalizeEmail, dedupeEmails, parseEmailList } from './utils.js';
import { autoFillFollowUpMessages, formatWorkflowDate, rememberTemplateBaseline } from './ui.js';

let partnerEmailLookup = new Map();
let selectedPartnerEmails = new Set();
let partnerRecords = [];

export function getManualCcEmails(widgetQuery) {
    const field = widgetQuery('#cc');
    if (!field) return [];
    const all = parseEmailList(field.value || '');
    return all.filter(email => !selectedPartnerEmails.has(normalizeEmail(email)));
}

export function persistCcValue(widgetQuery) {
    const field = widgetQuery('#cc');
    if (!field) return;
    chrome.storage.sync.set({ ccList: field.value });
}

export function handlePartnerSelectionChange(event, widgetQuery) {
    const select = event?.currentTarget;
    if (!select) return;

    const manualEmails = getManualCcEmails(widgetQuery);
    const options = Array.from(select.selectedOptions || []);
    const normalizedSelection = new Set();
    const partnerEmails = [];

    for (const option of options) {
        const email = String(option.dataset?.email || option.value || '').trim();
        const key = normalizeEmail(email);
        if (!key || normalizedSelection.has(key)) continue;
        normalizedSelection.add(key);
        const entry = partnerEmailLookup.get(key);
        partnerEmails.push(entry?.email || email);
    }

    selectedPartnerEmails = normalizedSelection;

    const combined = dedupeEmails([...manualEmails, ...partnerEmails]);
    const field = widgetQuery('#cc');
    if (field) {
        field.value = combined.join('; ');
        persistCcValue(widgetQuery);
    }
}

export async function hydratePartnerPicker($, sendMessageWithTimeout, setStatus, widgetQuery) {
    const select = widgetQuery('#partnerSelect');
    if (!select) return;

    select.disabled = true;
    select.innerHTML = '<option disabled>Loading partners...</option>';

    try {
        const response = await sendMessageWithTimeout('FETCH_PARTNERS', {}, 10000);
        if (!response?.ok) throw new Error(response?.error || 'Unknown error');

        const partners = Array.isArray(response.partners) ? response.partners.filter(p => p?.name && p?.email) : [];
        partners.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

        partnerEmailLookup = new Map();
        partnerRecords = partners;
        partners.forEach(partner => {
            const key = normalizeEmail(partner.email);
            if (!key) return;
            partnerEmailLookup.set(key, { name: partner.name, email: partner.email });
        });

        select.innerHTML = '';
        if (!partners.length) {
            select.innerHTML = '<option disabled>No partners found</option>';
            selectedPartnerEmails = new Set();
            select.disabled = true;
            return;
        }

        const field = widgetQuery('#cc');
        const existingEmails = field ? parseEmailList(field.value || '') : [];
        const existingNormalized = new Set(existingEmails.map(normalizeEmail));

        const newSelection = new Set();

        for (const partner of partners) {
            const option = document.createElement('option');
            option.value = partner.email;
            option.dataset.email = partner.email;
            option.textContent = partner.name;
            option.title = partner.name + ' - ' + partner.email;

            const key = normalizeEmail(partner.email);
            if (existingNormalized.has(key)) {
                option.selected = true;
                newSelection.add(key);
            }

            select.appendChild(option);
        }

        selectedPartnerEmails = newSelection;

        select.multiple = true;
        select.size = Math.min(Math.max(partners.length, 3), 6);

        if (field) {
            const manualEmails = existingEmails.filter(email => !partnerEmailLookup.has(normalizeEmail(email)));
            const partnerEmails = Array.from(newSelection).map(key => partnerEmailLookup.get(key)?.email).filter(Boolean);
            const combined = dedupeEmails([...manualEmails, ...partnerEmails]);
            const combinedValue = combined.join('; ');
            if (field.value != combinedValue) {
                field.value = combinedValue;
                persistCcValue(widgetQuery);
            }
        }

        select.disabled = false;

        populatePartnerForwardSelect($, partners, widgetQuery);
    } catch (error) {
        console.warn('[Specter-Outreach] Unable to load partners from Supabase:', error);
        setStatus('Partner list unavailable: ' + error.message, widgetQuery);
        select.innerHTML = '<option disabled>Unable to load partners</option>';
        select.disabled = true;
        partnerEmailLookup = new Map();
        selectedPartnerEmails = new Set();
    }

    return partnerRecords;
}

export function populatePartnerForwardSelect($, partners = [], widgetQuery) {
    const forwardSelect = widgetQuery('#partnerForwardSelect');
    if (!forwardSelect) return;

    const current = forwardSelect.value;
    forwardSelect.innerHTML = '<option value="">Select partner</option>';

    partners.forEach(partner => {
        const option = document.createElement('option');
        option.value = partner.id || partner.email || '';
        option.dataset.email = partner.email;
        option.dataset.partnerId = partner.id || '';
        option.textContent = partner.name;
        if (current && option.value === current) {
            option.selected = true;
        }
        forwardSelect.appendChild(option);
    });

    autoFillFollowUpMessages(widgetQuery);
}

export function collectWorkflowStepConfigs(widgetQuery) {
    const followUpTriggerEl = widgetQuery('#followUpTrigger');
    const linkedinTriggerEl = widgetQuery('#linkedinTrigger');
    const partnerTriggerEl = widgetQuery('#partnerTrigger');
    const partnerForwardSelect = widgetQuery('#partnerForwardSelect');
    const selectedForwardOption = partnerForwardSelect?.selectedOptions?.[0] || null;
    const selectedPartnerId = selectedForwardOption?.dataset?.partnerId || partnerForwardSelect?.value || '';

    const steps = [
        {
            key: 'Email follow-up',
            label: 'Email follow-up',
            enabled: !!widgetQuery('#autoFollowUp')?.checked,
            trigger: followUpTriggerEl?.value || '',
            message: widgetQuery('#followUpTemplate')?.value || ''
        },
        {
            key: 'LinkedIn request',
            label: 'LinkedIn request',
            enabled: !!widgetQuery('#linkedinFollowUpToggle')?.checked,
            trigger: linkedinTriggerEl?.value || '',
            message: widgetQuery('#linkedinMessage')?.value || ''
        },
        {
            key: 'Forward to partner',
            label: 'Forward to partner',
            enabled: !!widgetQuery('#partnerEscalationToggle')?.checked,
            trigger: partnerTriggerEl?.value || '',
            message: widgetQuery('#partnerMessage')?.value || '',
            partnerId: selectedPartnerId
        }
    ];

    return steps;
}

export function initializeWorkflowDefaults(widgetQuery) {
    const followUpTriggerEl = widgetQuery('#followUpTrigger');
    const linkedinTriggerEl = widgetQuery('#linkedinTrigger');
    const partnerTriggerEl = widgetQuery('#partnerTrigger');

    const now = new Date();
    if (followUpTriggerEl && !followUpTriggerEl.value) {
        const days = 7;
        const future = new Date(now.getTime() + days * 86400000);
        followUpTriggerEl.value = future.toISOString().slice(0, 16);
    }
    if (linkedinTriggerEl && !linkedinTriggerEl.value) {
        const future = new Date(now.getTime() + 9 * 86400000);
        linkedinTriggerEl.value = future.toISOString().slice(0, 16);
    }
    if (partnerTriggerEl && !partnerTriggerEl.value) {
        const future = new Date(now.getTime() + 14 * 86400000);
        partnerTriggerEl.value = future.toISOString().slice(0, 16);
    }
}

export function updateWorkflowPreviewUI($, workflowUtils, workflowSnapshot, widgetQuery, previewOnly = false) {
    const list = widgetQuery('#currentWorkflowPreview');
    if (!list) return;

    const steps = collectWorkflowStepConfigs(widgetQuery);
    const fallbackPartnerId = workflowSnapshot?.fallbackPartnerId || null;
    let previewTasks = [];
    try {
        previewTasks = workflowUtils.buildTaskPayloads({
            companyId: workflowSnapshot?.company?.id || 'preview',
            steps,
            fallbackPartnerId
        });
    } catch (err) {
        console.warn('[Specter-Outreach] Could not build preview tasks:', err);
    }

    const items = [];
    if (!previewOnly && Array.isArray(workflowSnapshot?.tasks)) {
        workflowSnapshot.tasks.forEach(task => {
            items.push({
                label: task.upcoming_task,
                trigger: task.trigger_date,
                message: task.message_text || '',
                source: 'supabase'
            });
        });
    }

    const shouldIncludePreview = previewOnly || !Array.isArray(workflowSnapshot?.tasks) || !workflowSnapshot.tasks.length;
    if (shouldIncludePreview) {
        previewTasks.forEach(task => {
            items.push({
                label: task.upcoming_task,
                trigger: task.trigger_date,
                message: task.message_text || '',
                source: 'preview'
            });
        });
    }

    list.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('li');
        empty.className = 'workflow-preview-item';
        empty.textContent = 'No workflow steps configured yet.';
        list.appendChild(empty);
        return;
    }

    items.sort((a, b) => new Date(a.trigger || 0) - new Date(b.trigger || 0));

    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'workflow-preview-item';
        const badge = item.source === 'supabase' ? '<span style="font-size:11px;color:#2563eb;">Supabase</span>' : '<span style="font-size:11px;color:#4b5563;">Pending</span>';
        li.innerHTML = [
            '<div class="workflow-task-header">',
            '<strong>' + item.label + '</strong>',
            '<time>' + formatWorkflowDate(item.trigger) + '</time>',
            '</div>',
            '<div style="font-size:12px;color:#4b5563;margin-top:6px;">' + (item.message || '—') + '</div>',
            '<div style="margin-top:4px;">' + badge + '</div>'
        ].join('\n');
        list.appendChild(li);
    });
}

export function renderPipelineTasks($, tasks = [], widgetQuery, sendMessageWithTimeout, setStatus, refreshWorkflowSnapshotCallback) {
    const list = widgetQuery('#pipelineTasksList');
    if (!list) return;
    list.innerHTML = '';

    if (!tasks.length) {
        const li = document.createElement('li');
        li.className = 'workflow-preview-item';
        li.textContent = 'No upcoming tasks from other companies.';
        list.appendChild(li);
        return;
    }

    const sortedTasks = [...tasks].sort((a, b) => new Date(a.trigger_date || 0) - new Date(b.trigger_date || 0));

    sortedTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'workflow-preview-item pipeline-task-item';

        const header = document.createElement('div');
        header.className = 'pipeline-task-header';

        const title = document.createElement('strong');
        title.textContent = task?.upcoming_task || 'Scheduled task';
        header.appendChild(title);

        const timeEl = document.createElement('time');
        timeEl.textContent = formatWorkflowDate(task?.trigger_date);
        header.appendChild(timeEl);

        li.appendChild(header);

        const companyName = task?.company?.name || 'Unknown company';
        const companyEl = document.createElement('div');
        companyEl.className = 'pipeline-task-company';
        companyEl.textContent = companyName;
        li.appendChild(companyEl);

        const message = String(task?.message_text || '').trim();
        if (message) {
            const messageEl = document.createElement('div');
            messageEl.className = 'pipeline-task-message';
            messageEl.textContent = message;
            li.appendChild(messageEl);
        }

        const actions = document.createElement('div');
        actions.className = 'pipeline-task-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'pipeline-task-delete-btn';
        deleteBtn.textContent = 'Delete';

        const handleDelete = async (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (!task?.id) {
                setStatus('Task is missing an id and cannot be deleted.', widgetQuery);
                return;
            }

            if (deleteBtn.disabled) return;

            const originalText = deleteBtn.textContent;
            deleteBtn.disabled = true;
            deleteBtn.textContent = 'Deleting…';
            setStatus('Deleting task…', widgetQuery);

            try {
                const response = await sendMessageWithTimeout('DELETE_SUPABASE_TASK', { taskId: task.id }, 15000);
                if (response?.ok) {
                    setStatus('Task deleted.', widgetQuery);
                    refreshWorkflowSnapshotCallback();
                } else {
                    const errorMessage = response?.error ? 'Could not delete task: ' + response.error : 'Could not delete task.';
                    setStatus(errorMessage, widgetQuery);
                    deleteBtn.disabled = false;
                    deleteBtn.textContent = originalText;
                }
            } catch (err) {
                console.warn('[Specter-Outreach] Failed to delete task from Supabase:', err);
                setStatus('Could not delete task.', widgetQuery);
                deleteBtn.disabled = false;
                deleteBtn.textContent = originalText;
            }
        };

        deleteBtn.addEventListener('click', handleDelete);

        actions.appendChild(deleteBtn);
        li.appendChild(actions);

        list.appendChild(li);
    });
}

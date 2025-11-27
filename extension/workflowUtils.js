export function parseTriggerDate(value) {
    if (!value) return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
        return value.toISOString();
    }

    const trimmed = String(value).trim();
    if (!trimmed) return null;

    // Support numeric offsets in days (e.g. "3" => 3 days from now)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const days = parseFloat(trimmed);
        if (!isFinite(days) || days < 0) return null;
        const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        return date.toISOString();
    }

    const date = new Date(trimmed);
    if (isNaN(date.getTime())) {
        return null;
    }
    return date.toISOString();
}

export function buildTaskPayloads({
    companyId,
    userId,
    steps = [],
    fallbackPartnerId = null
} = {}) {
    if (!companyId) {
        throw new Error('companyId is required to build task payloads');
    }

    const tasks = [];
    for (const step of steps) {
        if (!step || step.enabled === false) continue;

        const triggerIso = parseTriggerDate(step.trigger);
        if (!triggerIso) continue;

        const upcomingTask = (step.label || step.key || '').trim();
        if (!upcomingTask) continue;

        const message = (step.message || '').trim();

        const partnerId = step.partnerId || fallbackPartnerId || null;

        const context = step.context;
        const normalizedContext = context && typeof context === 'object'
            ? JSON.parse(JSON.stringify(context))
            : null;

        tasks.push({
            company_id: companyId,
            user_id: userId || null,
            partner_id: partnerId,
            upcoming_task: upcomingTask,
            trigger_date: triggerIso,
            message_text: message || null,
            context: normalizedContext
        });
    }

    return tasks;
}

export function summarizeTasks(tasks = []) {
    return tasks.map(task => ({
        label: task.upcoming_task,
        trigger: task.trigger_date,
        message: task.message_text || ''
    }));
}

export default {
    parseTriggerDate,
    buildTaskPayloads,
    summarizeTasks
};

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTriggerDate, buildTaskPayloads } from './workflowUtils.js';

test('parseTriggerDate handles datetime-local strings', () => {
    const iso = parseTriggerDate('2025-01-02T12:30');
    assert.ok(iso.startsWith('2025-01-02T12:30'), 'should keep provided local time');
});

test('parseTriggerDate handles numeric offsets', () => {
    const iso = parseTriggerDate('2');
    const diffMs = new Date(iso).getTime() - Date.now();
    assert.ok(diffMs > 0, 'offset should be in the future');
});

test('buildTaskPayloads filters disabled or invalid steps', () => {
    const tasks = buildTaskPayloads({
        companyId: 'company-123',
        userId: 'user-456',
        fallbackPartnerId: 'partner-xyz',
        steps: [
            { key: 'Follow-up email', enabled: true, trigger: '2025-01-01T09:00', message: 'Hello' },
            { key: 'LinkedIn request', enabled: false, trigger: '2025-01-02T09:00' },
            { key: 'Forward to partner', enabled: true, trigger: '', message: 'Ping partner', partnerId: 'partner-123' }
        ]
    });

    assert.equal(tasks.length, 1, 'only one valid task expected');
    assert.equal(tasks[0].company_id, 'company-123');
    assert.equal(tasks[0].user_id, 'user-456');
    assert.equal(tasks[0].partner_id, 'partner-xyz');
    assert.equal(tasks[0].message_text, 'Hello');
    assert.equal(tasks[0].context, null, 'context defaults to null when absent');
});

test('buildTaskPayloads uses explicit partner when provided', () => {
    const [task] = buildTaskPayloads({
        companyId: 'company-1',
        steps: [
            { key: 'Forward', enabled: true, trigger: '2025-01-01T08:00', partnerId: 'partner-1', message: 'Forwarding' }
        ]
    });

    assert.equal(task.partner_id, 'partner-1');
    assert.equal(task.message_text, 'Forwarding');
});

test('buildTaskPayloads clones step context when provided', () => {
    const context = { anchorId: '123', nested: { a: 1 } };
    const [task] = buildTaskPayloads({
        companyId: 'company-ctx',
        steps: [
            { key: 'Email follow-up', enabled: true, trigger: '2025-03-01T10:00', message: 'Hi', context }
        ]
    });

    assert.deepEqual(task.context, context);
    assert.notStrictEqual(task.context, context, 'context should be cloned');
});

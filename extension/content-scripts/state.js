// content-scripts/state.js

export let partnerEmailLookup = new Map();
export let selectedPartnerEmails = new Set();
export let partnerRecords = [];
export let workflowSnapshot = { tasks: [], outstandingTasks: [], company: null, fallbackPartnerId: null };
export let forwardPartnerReminderTimeoutId = null;

export function resetState() {
    partnerEmailLookup = new Map();
    selectedPartnerEmails = new Set();
    partnerRecords = [];
    workflowSnapshot = { tasks: [], outstandingTasks: [], company: null, fallbackPartnerId: null };
    forwardPartnerReminderTimeoutId = null;
}

export function setWorkflowSnapshot(newSnapshot) {
    workflowSnapshot = newSnapshot;
}

export function setPartnerRecords(records) {
    partnerRecords = records;
}

export function setPartnerEmailLookup(lookup) {
    partnerEmailLookup = lookup;
}

export function setSelectedPartnerEmails(emails) {
    selectedPartnerEmails = emails;
}

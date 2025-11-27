// content-scripts/state.js

export let partnerEmailLookup = new Map();
export let selectedPartnerEmails = new Set();
export let partnerRecords = [];
export let workflowSnapshot = { tasks: [], outstandingTasks: [], company: null, fallbackPartnerId: null };
export let forwardPartnerReminderTimeoutId = null;

// New state variables to replace window globals
export let userInfo = null;
export let msToken = null;
export let companyContext = null;
export let activeFounderContact = null;
export let unipileAccountId = null;
export let unipileAccountDetails = null;
export let specterLastOverdueProcessMs = 0;
export let specterDefaultModelId = 'deepseek/deepseek-v3.1-terminus';
export let specterModelOptions = [];
export let affinityCompanyIdentifiers = null;
export let affinityLastDomain = null;
export let affinityDidInitialCheck = false;
export let unipilePollTimerId = null;
export let unipilePollNoticeTimeoutId = null;

export function resetState() {
    partnerEmailLookup = new Map();
    selectedPartnerEmails = new Set();
    partnerRecords = [];
    workflowSnapshot = { tasks: [], outstandingTasks: [], company: null, fallbackPartnerId: null };
    forwardPartnerReminderTimeoutId = null;

    userInfo = null;
    msToken = null;
    companyContext = null;
    activeFounderContact = null;
    unipileAccountId = null;
    unipileAccountDetails = null;
    specterLastOverdueProcessMs = 0;
    specterDefaultModelId = 'deepseek/deepseek-v3.1-terminus';
    specterModelOptions = [];
    affinityCompanyIdentifiers = null;
    affinityLastDomain = null;
    affinityDidInitialCheck = false;
    unipilePollTimerId = null;
    unipilePollNoticeTimeoutId = null;
}

// Getters and Setters

export function setUserInfo(info) { userInfo = info; }
export function setMsToken(token) { msToken = token; }
export function setCompanyContext(ctx) { companyContext = ctx; }
export function setActiveFounderContact(contact) { activeFounderContact = contact; }
export function setUnipileAccountId(id) { unipileAccountId = id; }
export function setUnipileAccountDetails(details) { unipileAccountDetails = details; }
export function setSpecterLastOverdueProcessMs(ms) { specterLastOverdueProcessMs = ms; }
export function setSpecterDefaultModelId(id) { specterDefaultModelId = id; }
export function setSpecterModelOptions(options) { specterModelOptions = options; }
export function setAffinityCompanyIdentifiers(ids) { affinityCompanyIdentifiers = ids; }
export function setAffinityLastDomain(domain) { affinityLastDomain = domain; }
export function setAffinityDidInitialCheck(checked) { affinityDidInitialCheck = checked; }
export function setUnipilePollTimerId(id) { unipilePollTimerId = id; }
export function setUnipilePollNoticeTimeoutId(id) { unipilePollNoticeTimeoutId = id; }

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

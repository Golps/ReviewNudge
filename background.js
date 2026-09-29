// Background: runs one order at a time, tracks its progress, and records
// what Amazon said. Three ways an order can run:
//   "fast"  – the orders page sends the same request Amazon's Yes button sends
//   "frame" – the orders page drives Amazon's own pages in an invisible frame
//   "tab"   – Amazon's own pages in a background tab this script opens
//
// All state lives in extension storage, not in memory, so the browser suspending
// this script never loses a job. This script is the only writer of order
// results ("statuses"); the orders page only reads them.
const api = globalThis.browser ?? globalThis.chrome;

const STALE_JOB_MS = 4 * 60 * 1000; // a job older than this is treated as dead
const CLOSE_AFTER_INELIGIBLE_DAYS = 35; // never became eligible in this long: give up
const CLOSE_AFTER_ORDER_AGE_DAYS = 45; // Amazon says not eligible and the order is this old: window has passed
const FORGET_AFTER_CLOSE_DAYS = 1; // forget an order this many days after its 30-day window ends
const FORGET_AFTER_ORDER_DAYS = 45; // …or, with no delivery estimate, this long after the order date
const FINAL = new Set(['sent', 'already', 'skippedReturn', 'closed', 'unknown']);
const REPORTABLE = new Set(['sent', 'already', 'notEligible', 'eligible', 'skippedReturn', 'error', 'unknown']);
const STAGES = ['start', 'confirmPage', 'clickedYes'];
const PAGE_OWNED = new Set(['fast', 'frame']); // jobs driven by the orders page itself

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

async function getStored(keys) {
  return (await api.storage.local.get(keys)) || {};
}
async function getJob() {
  return (await getStored('currentJob')).currentJob || null;
}
const saveJob = (job) => api.storage.local.set({ currentJob: job });

// Handle one event at a time so read-modify-write on storage never interleaves.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// Old results are dropped once Amazon's window has closed for good: the pill
// already shows "Past 30 days" from the dates alone, so nothing is lost.
function prune(statuses, keepId) {
  const day = localDay();
  for (const [id, rec] of Object.entries(statuses)) {
    if (id === keepId) continue; // the order just recorded stays until next time
    if (!rec) {
      delete statuses[id];
      continue;
    }
    const expired = isDay(rec.closesOn)
      ? daysBetween(rec.closesOn, day) > FORGET_AFTER_CLOSE_DAYS - 1
      : isDay(rec.orderDate)
        ? daysBetween(rec.orderDate, day) > FORGET_AFTER_ORDER_DAYS
        : Date.now() - (rec.checkedAt || 0) > FORGET_AFTER_ORDER_DAYS * 86400000;
    if (expired) delete statuses[id];
  }
  return statuses;
}

function buildRecord(prev, orderId, result, orderDate, dryRun, closesOn) {
  const day = localDay();
  const rec = {
    ...prev,
    status: result.status,
    detail: result.detail || '',
    fatal: !!result.fatal,
    checkedAt: Date.now(),
    checkedDay: day,
    mode: dryRun ? 'dry' : 'live',
  };
  if (orderDate) rec.orderDate = orderDate;
  if (isDay(closesOn)) rec.closesOn = closesOn;
  // Amazon itself answered today (not a load failure): today's label can be trusted.
  if (result.status !== 'error') rec.verifiedDay = day;
  delete rec.checkFailedDay;
  delete rec.checkNote;
  delete rec.checkFatal;
  if (result.status === 'skippedReturn') rec.returnKind = result.returnKind === 'refund' ? 'refund' : 'return';
  if (result.status === 'notEligible') {
    rec.firstIneligibleDay = prev.firstIneligibleDay || day;
    const since = daysBetween(rec.firstIneligibleDay, day);
    const age = rec.orderDate ? daysBetween(rec.orderDate, day) : null;
    if (since >= CLOSE_AFTER_INELIGIBLE_DAYS) {
      rec.status = 'closed';
      rec.detail = `Amazon has said "not eligible" since ${rec.firstIneligibleDay}.`;
    } else if (age !== null && age > CLOSE_AFTER_ORDER_AGE_DAYS) {
      rec.status = 'closed';
      rec.detail = `Ordered ${age} days ago; Amazon says it's past the window.`;
    }
  }
  return rec;
}

async function recordResult(job, result) {
  const { statuses = {}, today } = await getStored(['statuses', 'today']);
  const day = localDay();
  const prev = statuses[job.orderId] || {};
  let rec;
  let changed = true;
  // "Needs a look" means we pressed Yes and never saw Amazon's answer. A later
  // check-only read settles it: Amazon says "already requested" (so it went
  // through), or offers Yes again (so it never did).
  const settlesUnknown = job.dryRun && prev.status === 'unknown' && (result.status === 'already' || result.status === 'eligible');
  if (job.dryRun && result.status === 'error') {
    // A check that couldn't load says nothing about the order: keep what we knew.
    rec = { ...prev, checkedAt: Date.now(), checkFailedDay: day, checkNote: result.detail, checkFatal: !!result.fatal };
    if (job.orderDate) rec.orderDate = job.orderDate;
    if (isDay(job.closesOn)) rec.closesOn = job.closesOn;
    changed = false;
  } else if (FINAL.has(prev.status) && !settlesUnknown) {
    // Never change a finished order. Just note that it was looked at.
    rec = { ...prev, checkedAt: Date.now(), lastNote: result.detail };
    changed = false;
  } else {
    rec = buildRecord(prev, job.orderId, result, job.orderDate, job.dryRun, job.closesOn);
  }
  let counter = today && today.day === day ? today : { day, count: 0 };
  if (changed && !job.dryRun && (rec.status === 'sent' || rec.status === 'unknown')) {
    counter = { day, count: counter.count + 1 };
  }
  statuses[job.orderId] = rec;
  await api.storage.local.set({ statuses: prune(statuses, job.orderId), today: counter });
}

async function finishJob(job, result) {
  await recordResult(job, result);
  await api.storage.local.remove('currentJob');
  for (const id of job.tabIds || []) {
    try {
      await api.tabs.remove(id);
    } catch (e) {
      /* already closed */
    }
  }
  if (job.showTab && job.returnTabId != null && api.tabs.update) {
    try {
      await api.tabs.update(job.returnTabId, { active: true }); // back to the orders page
    } catch (e) {
      /* orders tab is gone */
    }
  }
}

function failureFor(job, why) {
  if (job.stage === 'clickedYes') {
    return {
      status: 'unknown',
      fatal: true,
      detail: `${why} after the request was sent. Check this order in Seller Central.`,
    };
  }
  return { status: 'error', fatal: true, detail: `${why}. Nothing was sent.` };
}

async function runJob(req, sender) {
  const { orderId, url, dryRun, orderDate, closesOn, showTab, mode } = req || {};
  if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId || '')) return { ok: false, reason: 'Invalid order ID.' };
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return { ok: false, reason: 'Invalid order URL.' };
  }
  if (u.protocol !== 'https:' || u.hostname !== 'sellercentral.amazon.com') {
    return { ok: false, reason: 'Order URL is not on sellercentral.amazon.com.' };
  }

  const existing = await getJob();
  if (existing) {
    if (Date.now() - existing.startedAt < STALE_JOB_MS) return { ok: false, reason: 'busy' };
    await finishJob(existing, failureFor(existing, 'It never finished'));
  }

  const job = {
    orderId,
    url: u.href,
    mode: PAGE_OWNED.has(mode) ? mode : 'tab',
    ownerTabId: sender && sender.tab ? sender.tab.id : null,
    dryRun: dryRun !== false, // anything but an explicit false is a check-only run
    orderDate: isDay(orderDate) ? orderDate : null,
    closesOn: isDay(closesOn) ? closesOn : null,
    showTab: !!showTab,
    returnTabId: sender && sender.tab ? sender.tab.id : null,
    stage: 'start',
    note: '',
    startedAt: Date.now(),
    tabIds: [],
    activeTabId: null,
  };
  await saveJob(job);
  if (PAGE_OWNED.has(job.mode)) {
    if (job.ownerTabId == null) {
      await api.storage.local.remove('currentJob');
      return { ok: false, reason: 'No orders tab.' };
    }
    return { ok: true }; // the orders page does the work itself
  }
  let tab;
  try {
    tab = await api.tabs.create({ url: u.href, active: !!showTab });
  } catch (e) {
    await api.storage.local.remove('currentJob');
    return { ok: false, reason: `Couldn't open the order page (${e && e.message}).` };
  }
  job.tabIds = [tab.id];
  job.activeTabId = tab.id;
  await saveJob(job);
  return { ok: true };
}

// Who may move a job forward: the job's tab (tab mode) or the orders page's
// top frame (fast/frame modes).
function isActor(job, sender) {
  if (!job || !sender || !sender.tab) return false;
  if (PAGE_OWNED.has(job.mode)) return sender.tab.id === job.ownerTabId && !sender.frameId;
  return sender.tab.id === job.activeTabId;
}

async function hello(sender) {
  const job = await getJob();
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!job || PAGE_OWNED.has(job.mode) || tabId === undefined || job.activeTabId == null) return null;

  if (!job.tabIds.includes(tabId)) {
    // Amazon opened its review page in a new tab: take that tab over.
    const url = (sender && sender.url) || (sender.tab && sender.tab.url) || '';
    const adoptable =
      job.stage === 'confirmPage' &&
      url.includes(job.orderId) &&
      /review|solicit|messaging/i.test(url) &&
      Date.now() - job.startedAt < STALE_JOB_MS;
    if (!adoptable) return null;
    job.tabIds.push(tabId);
    job.activeTabId = tabId;
    await saveJob(job);
  }
  if (tabId !== job.activeTabId) return null; // an older tab of this job stands down
  return { orderId: job.orderId, dryRun: job.dryRun, stage: job.stage, note: job.note };
}

async function setStage(sender, stage, note) {
  const job = await getJob();
  if (!isActor(job, sender)) return false;
  if (STAGES.indexOf(stage) !== STAGES.indexOf(job.stage) + 1) return false;
  if (stage === 'clickedYes' && job.dryRun) return false; // a check-only run can never send
  job.stage = stage;
  if (note) job.note = String(note).slice(0, 200);
  await saveJob(job);
  return true;
}

async function report(sender, result) {
  const job = await getJob();
  if (!isActor(job, sender)) return false;
  const r = {
    status: REPORTABLE.has(result && result.status) ? result.status : 'error',
    detail: String((result && result.detail) || '').slice(0, 300),
    fatal: !!(result && result.fatal),
    returnKind: result && result.returnKind,
  };
  // After sending, anything short of a clear answer means "we don't know" –
  // unless Amazon clearly rejected the request before processing it.
  const notProcessed = !!(result && result.notProcessed);
  if (job.stage === 'clickedYes' && ((r.status === 'error' && !notProcessed) || r.status === 'eligible')) {
    r.status = 'unknown';
    r.fatal = true;
  }
  if (job.note && r.status !== 'error') r.detail = `${r.detail} ${job.note}`.trim();
  await finishJob(job, r);
  return true;
}

// A quick read-only lookup from the orders page (nothing was sent).
// Only a clear answer is recorded; a finished order is never changed, except that
// "Needs a look" is settled by it.
async function recordCheck(msg) {
  const { orderId, answer, orderDate, closesOn } = msg || {};
  if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId || '') || !['already', 'eligible'].includes(answer)) return false;
  if (await getJob()) return false; // a send is in progress; its own answer wins
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[orderId] || {};
  if (FINAL.has(prev.status) && prev.status !== 'unknown') return false;
  const result =
    answer === 'already'
      ? { status: 'already', detail: 'Amazon says a review was already requested for this order.' }
      : { status: 'eligible', detail: 'Amazon accepts a review request for this order.' };
  statuses[orderId] = buildRecord(prev, orderId, result, isDay(orderDate) ? orderDate : null, false, closesOn);
  await api.storage.local.set({ statuses: prune(statuses, orderId) });
  return true;
}

// A return/refund spotted in the orders list itself, before anything is sent.
async function markReturn(msg) {
  const { orderId, detail, returnKind, orderDate, closesOn } = msg || {};
  if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId || '')) return false;
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[orderId] || {};
  if (FINAL.has(prev.status)) return false;
  statuses[orderId] = buildRecord(prev, orderId, { status: 'skippedReturn', detail, returnKind }, isDay(orderDate) ? orderDate : null, false, closesOn);
  await api.storage.local.set({ statuses: prune(statuses, orderId) });
  return true;
}

async function abort(orderId) {
  const job = await getJob();
  if (!job || job.orderId !== orderId) return false;
  await finishJob(job, failureFor(job, 'Timed out waiting for Amazon'));
  return true;
}

// Drop a job that hasn't sent anything, without recording a result
// (used when an order is switched to a different method).
async function cancel(sender, orderId) {
  const job = await getJob();
  if (!job || job.orderId !== orderId || job.stage === 'clickedYes' || !isActor(job, sender)) return false;
  await api.storage.local.remove('currentJob');
  return true;
}

async function tabClosed(tabId) {
  const job = await getJob();
  if (!job) return;
  if (PAGE_OWNED.has(job.mode)) {
    if (tabId === job.ownerTabId) await finishJob(job, failureFor(job, 'The orders tab was closed'));
    return;
  }
  if (!job.tabIds.includes(tabId)) return;
  job.tabIds = job.tabIds.filter((id) => id !== tabId);
  if (tabId === job.activeTabId) await finishJob(job, failureFor(job, 'The order tab was closed'));
  else await saveJob(job);
}

async function clearResults() {
  if (await getJob()) return { ok: false, reason: 'busy' };
  await api.storage.local.remove('statuses');
  return { ok: true };
}

// Repair results saved by earlier versions:
// - v0.3 wrongly closed orders that a check had called "eligible" (Amazon shows
//   Yes even for orders outside its window; it only says "not eligible" after Yes).
// - "eligible" results from the old check-only mode meant nothing; forget them.
async function migrate() {
  const { statuses } = await getStored(['statuses']);
  if (!statuses) return;
  let changed = false;
  for (const [id, rec] of Object.entries(statuses)) {
    if (!rec) continue;
    if (rec.status === 'closed' && /^It was eligible on/.test(rec.detail || '')) {
      statuses[id] = { ...rec, status: 'notEligible', checkedDay: '', detail: 'Outside Amazon\'s 5–30 day window', seenEligible: undefined, eligibleDay: undefined };
      changed = true;
    } else if (rec.status === 'eligible' || rec.status === 'greyed') {
      // Old check-only results and 0.8.2's greyed-button guesses: not reliable, forget them.
      delete statuses[id];
      changed = true;
    }
  }
  const before = Object.keys(statuses).length;
  prune(statuses);
  if (changed || Object.keys(statuses).length !== before) await api.storage.local.set({ statuses });
}
serial(migrate);

// Replies go through sendResponse (return true keeps the channel open). This
// works the same in Chrome, Firefox and Safari; returning a Promise does not.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = handle(msg, sender);
  if (reply === undefined) return false;
  Promise.resolve(reply).then(
    (value) => sendResponse(value),
    () => sendResponse(undefined)
  );
  return true;
});

function handle(msg, sender) {
  if (!msg || typeof msg.type !== 'string') return undefined;
  switch (msg.type) {
    case 'runJob':
      return serial(() => runJob(msg.job, sender));
    case 'hello':
      return serial(() => hello(sender));
    case 'stage':
      return serial(() => setStage(sender, msg.stage, msg.note));
    case 'jobResult':
      return serial(() => report(sender, msg.result));
    case 'checked':
      return serial(() => recordCheck(msg));
    case 'markReturn':
      return serial(() => markReturn(msg));
    case 'abortJob':
      return serial(() => abort(msg.orderId));
    case 'cancelJob':
      return serial(() => cancel(sender, msg.orderId));
    case 'clearResults':
      return serial(() => clearResults());
    default:
      return undefined;
  }
}

api.tabs.onRemoved.addListener((tabId) => {
  serial(() => tabClosed(tabId));
});

// Toolbar button: open Manage Orders when you're not already in Seller Central.
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener((tab) => {
    if (!/^https:\/\/sellercentral\.amazon\.com\//.test((tab && tab.url) || '')) {
      api.tabs.create({ url: 'https://sellercentral.amazon.com/orders-v3' });
    }
  });
}

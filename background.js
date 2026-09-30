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
const REPORTABLE = new Set(['sent', 'already', 'notEligible', 'skippedReturn', 'error', 'unknown']);
const ANSWERED = new Set(['sent', 'already', 'notEligible', 'eligible']); // Amazon itself gave this answer
const STAGES = ['start', 'confirmPage', 'clickedYes'];
const PAGE_OWNED = new Set(['fast', 'frame']); // jobs driven by the orders page itself
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const MARKETPLACE_ID = /^[A-Z0-9]{8,16}$/;

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
const newJobId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function getStored(keys) {
  return (await api.storage.local.get(keys)) || {};
}
async function getJob() {
  return (await getStored('currentJob')).currentJob || null;
}
const saveJob = (job) => api.storage.local.set({ currentJob: job });
const isLive = (job) => !!job && Date.now() - job.startedAt < STALE_JOB_MS;

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

function buildRecord(prev, result, orderDate, closesOn) {
  const day = localDay();
  const rec = {
    ...prev,
    status: result.status,
    detail: result.detail || '',
    fatal: !!result.fatal,
    checkedAt: Date.now(),
    checkedDay: day,
  };
  delete rec.lookedAt;
  if (orderDate) rec.orderDate = orderDate;
  if (isDay(closesOn)) rec.closesOn = closesOn;
  // Amazon itself answered today: today's label can be trusted. "Needs a look"
  // is the opposite (no answer), so it stays open to lookups.
  if (ANSWERED.has(result.status)) rec.verifiedDay = day;
  else if (result.status === 'unknown') delete rec.verifiedDay;
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
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[job.orderId] || {};
  // Never change a finished order. The new timestamp still tells the orders page the job ended.
  statuses[job.orderId] = FINAL.has(prev.status) ? { ...prev, checkedAt: Date.now() } : buildRecord(prev, result, job.orderDate, job.closesOn);
  await api.storage.local.set({ statuses: prune(statuses, job.orderId) });
}

async function closeTabs(job) {
  for (const id of job.tabIds || []) {
    try {
      await api.tabs.remove(id);
    } catch (e) {
      /* already closed */
    }
  }
}

async function finishJob(job, result) {
  await recordResult(job, result);
  await api.storage.local.remove('currentJob');
  await closeTabs(job);
}

// A job whose page went away (reloaded, closed, or it never finished). Before
// the request went out nothing happened, so nothing is recorded. After it went
// out, the order becomes "Needs a look" until a lookup shows Amazon's answer.
async function endAbandoned(job, why) {
  if (job.stage === 'clickedYes') {
    await finishJob(job, { status: 'unknown', fatal: true, detail: `${why} after the request was sent. Check this order in Seller Central.` });
  } else {
    await api.storage.local.remove('currentJob');
    await closeTabs(job);
  }
}

function failureFor(job, why) {
  if (job.stage === 'clickedYes') {
    return { status: 'unknown', fatal: true, detail: `${why} after the request was sent. Check this order in Seller Central.` };
  }
  return { status: 'error', fatal: true, detail: `${why}. Nothing was sent.` };
}

async function runJob(req, sender) {
  const { orderId, url, orderDate, closesOn, mode, marketplaceId } = req || {};
  if (!ORDER_ID.test(orderId || '')) return { ok: false, reason: 'Invalid order ID.' };
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
    if (isLive(existing)) return { ok: false, reason: 'busy' };
    await endAbandoned(existing, 'It never finished');
  }
  // A finished order is never started again, whatever the orders page thinks.
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[orderId];
  if (prev && FINAL.has(prev.status)) return { ok: false, reason: 'final', record: prev };

  const job = {
    id: newJobId(),
    orderId,
    url: u.href,
    mode: PAGE_OWNED.has(mode) ? mode : 'tab',
    ownerTabId: sender && sender.tab ? sender.tab.id : null,
    orderDate: isDay(orderDate) ? orderDate : null,
    closesOn: isDay(closesOn) ? closesOn : null,
    marketplaceId: MARKETPLACE_ID.test(marketplaceId || '') ? marketplaceId : null,
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
    return { ok: true, jobId: job.id }; // the orders page does the work itself
  }
  let tab;
  try {
    tab = await api.tabs.create({ url: u.href, active: false });
  } catch (e) {
    await api.storage.local.remove('currentJob');
    return { ok: false, reason: `Couldn't open the order page (${e && e.message}).` };
  }
  job.tabIds = [tab.id];
  job.activeTabId = tab.id;
  await saveJob(job);
  return { ok: true, jobId: job.id };
}

// Who may move a job forward: the job's tab (tab mode) or the orders page's top
// frame (fast/frame modes), and only for this job: a late message from an
// earlier order's job never touches the current one.
function isActor(job, sender, jobId) {
  if (!job || !sender || !sender.tab || !jobId || job.id !== jobId) return false;
  if (PAGE_OWNED.has(job.mode)) return sender.tab.id === job.ownerTabId && !sender.frameId;
  return sender.tab.id === job.activeTabId;
}

async function hello(sender) {
  const job = await getJob();
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!job || job.mode !== 'tab' || tabId === undefined || job.activeTabId == null) return null;

  if (!job.tabIds.includes(tabId)) {
    // Amazon opened its review page in a new tab: take that tab over.
    const url = (sender && sender.url) || (sender.tab && sender.tab.url) || '';
    const adoptable = job.stage === 'confirmPage' && url.includes(job.orderId) && /review|solicit|messaging/i.test(url) && isLive(job);
    if (!adoptable) return null;
    job.tabIds.push(tabId);
    job.activeTabId = tabId;
    await saveJob(job);
  }
  if (tabId !== job.activeTabId) return null; // an older tab of this job stands down
  return { jobId: job.id, orderId: job.orderId, stage: job.stage, note: job.note, marketplaceId: job.marketplaceId };
}

async function setStage(sender, msg) {
  const { stage, note, jobId } = msg || {};
  const job = await getJob();
  if (!isActor(job, sender, jobId)) return false;
  if (STAGES.indexOf(stage) !== STAGES.indexOf(job.stage) + 1) return false;
  job.stage = stage;
  if (note) job.note = String(note).slice(0, 200);
  await saveJob(job);
  return true;
}

async function report(sender, msg) {
  const { result, jobId } = msg || {};
  const job = await getJob();
  if (!isActor(job, sender, jobId)) return false;
  const r = {
    status: REPORTABLE.has(result && result.status) ? result.status : 'error',
    detail: String((result && result.detail) || '').slice(0, 300),
    fatal: !!(result && result.fatal),
    returnKind: result && result.returnKind,
  };
  // After sending, anything short of a clear answer means "we don't know" –
  // unless Amazon clearly rejected the request before processing it.
  if (job.stage === 'clickedYes' && r.status === 'error' && !(result && result.notProcessed)) {
    r.status = 'unknown';
    r.fatal = true;
  }
  if (job.note && r.status !== 'error') r.detail = `${r.detail} ${job.note}`.trim();
  await finishJob(job, r);
  return true;
}

// A read-only lookup from the orders page (nothing was sent). A finished order
// is never changed, with one exception: "Needs a look" (Yes was pressed, the
// answer was never seen) is settled once Amazon says a request exists.
async function recordCheck(msg) {
  const { orderId, answer, orderDate, closesOn } = msg || {};
  if (!ORDER_ID.test(orderId || '') || !['already', 'eligible', 'notEligible'].includes(answer)) return false;
  const job = await getJob();
  if (job && job.orderId === orderId && isLive(job)) return false; // being sent now; its own answer wins
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[orderId] || {};
  const day = localDay();
  let result;
  if (prev.status === 'unknown') {
    if (answer === 'already') {
      result = { status: 'sent', detail: 'Amazon confirms the review request went through.' };
    } else if (answer === 'eligible' && prev.checkedDay && prev.checkedDay < day) {
      result = { status: 'eligible', detail: "Amazon still accepts a request, so the earlier one didn't go through." };
    } else {
      // Same day: Amazon may still be processing it. Leave it for a person and ask again later.
      statuses[orderId] = { ...prev, lookedAt: Date.now() };
      await api.storage.local.set({ statuses });
      return true;
    }
  } else if (FINAL.has(prev.status)) {
    return false;
  } else {
    result =
      answer === 'already'
        ? { status: 'already', detail: 'Amazon says a review was already requested for this order.' }
        : answer === 'eligible'
          ? { status: 'eligible', detail: 'Amazon accepts a review request for this order.' }
          : { status: 'notEligible', detail: String(msg.detail || "Amazon doesn't accept a request for this order right now.").slice(0, 200) };
  }
  statuses[orderId] = buildRecord(prev, result, isDay(orderDate) ? orderDate : null, closesOn);
  await api.storage.local.set({ statuses: prune(statuses, orderId) });
  return true;
}

// An order found on Manage Returns or with a return/refund in its row.
async function markReturn(msg) {
  const { orderId, detail, returnKind, orderDate, closesOn } = msg || {};
  if (!ORDER_ID.test(orderId || '')) return false;
  const job = await getJob();
  if (job && job.orderId === orderId && isLive(job)) return false; // its own job decides
  const { statuses = {} } = await getStored(['statuses']);
  const prev = statuses[orderId] || {};
  if (FINAL.has(prev.status)) return false;
  statuses[orderId] = buildRecord(prev, { status: 'skippedReturn', detail, returnKind }, isDay(orderDate) ? orderDate : null, closesOn);
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
async function cancel(sender, msg) {
  const { orderId, jobId } = msg || {};
  const job = await getJob();
  if (!job || job.orderId !== orderId || job.stage === 'clickedYes' || !isActor(job, sender, jobId)) return false;
  await api.storage.local.remove('currentJob');
  return true;
}

// The orders page (re)loaded in a tab: a job that page was running can't finish anymore.
async function pageLoaded(sender) {
  const job = await getJob();
  if (!job || !PAGE_OWNED.has(job.mode) || !sender || !sender.tab || sender.frameId) return false;
  if (sender.tab.id !== job.ownerTabId) return false;
  await endAbandoned(job, 'The page was reloaded');
  return true;
}

async function tabClosed(tabId) {
  const job = await getJob();
  if (!job) return;
  if (PAGE_OWNED.has(job.mode)) {
    if (tabId === job.ownerTabId) await endAbandoned(job, 'The orders tab was closed');
    return;
  }
  if (!job.tabIds.includes(tabId)) return;
  job.tabIds = job.tabIds.filter((id) => id !== tabId);
  if (tabId === job.activeTabId) await finishJob(job, failureFor(job, 'The order tab was closed'));
  else await saveJob(job);
}

// Tidy results saved by earlier versions: guesses that were never Amazon's answer
// ("greyed", unconfirmed "eligible") and fields no longer used.
async function migrate() {
  const { statuses } = await getStored(['statuses']);
  await api.storage.local.remove('today');
  if (!statuses) return;
  for (const [id, rec] of Object.entries(statuses)) {
    if (!rec || rec.status === 'greyed' || (rec.status === 'eligible' && !rec.verifiedDay)) {
      delete statuses[id];
      continue;
    }
    for (const k of ['mode', 'lastNote', 'checkFailedDay', 'checkNote', 'checkFatal', 'seenEligible', 'eligibleDay']) delete rec[k];
  }
  await api.storage.local.set({ statuses: prune(statuses) });
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
      return serial(() => setStage(sender, msg));
    case 'jobResult':
      return serial(() => report(sender, msg));
    case 'checked':
      return serial(() => recordCheck(msg));
    case 'markReturn':
      return serial(() => markReturn(msg));
    case 'abortJob':
      return serial(() => abort(msg.orderId));
    case 'cancelJob':
      return serial(() => cancel(sender, msg));
    case 'pageLoaded':
      return serial(() => pageLoaded(sender));
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

// Seller Central orders list.
// - "Request Reviews" in Amazon's toolbar: one click sends Amazon's review
//   request to every eligible order, page after page (Amazon's Next), then
//   shows a summary with the next days orders open. Click again to stop.
// - Orders on Manage Returns (any status) are never sent; if that list can't
//   be read in full, nothing is sent.
// - A pill under each order number: tap "Request review" to send just that
//   order. Returned/refunded orders show "↩ Returned · skipped" and are never sent.
// Everything else is automatic: returns are always checked, and the fastest
// working way to send is picked (with fallbacks) without any settings.
// This script only reads order results; the background script writes them.
(() => {
  if (window.top !== window) return;
  const api = globalThis.browser ?? globalThis.chrome;

  const GAP_MIN_MS = 3000; // pause between orders when sending the whole page
  const GAP_MAX_MS = 6000;
  const RESULT_TIMEOUT_MS = 120000; // give up on one order after this
  const RESCAN_MS = 3000;
  const FRAME_LOAD_TIMEOUT_MS = 25000; // an Amazon page loading in the invisible frame
  const OPENS_AFTER_DELIVERY_DAYS = 5; // Amazon: requests 5–30 days after delivery
  const TYPICAL_TRANSIT_DAYS = 3; // used only when an order has no "Deliver by" date
  const TOO_OLD_DAYS = 45; // well past 30 days after any normal delivery
  const COMING_UP_DAYS = 7;
  const MAX_PAGES = 100; // 100 orders per page → up to 10,000 orders in one run
  const NEXT_PAGE_TIMEOUT_MS = 30000;
  const PAGE_SETTLE_MS = 1500; // new page must stop changing this long before it's used
  const POLL_PAGE_MS = 300;
  const RETURNS_REFRESH_MS = 15 * 60 * 1000; // re-read Manage Returns this often during a long run
  const RETURNS_READ_TIMEOUT_MS = 180000;
  // Manage Returns (seller-fulfilled), every status, last 90 days: new layout first, classic as backup.
  const RETURN_MARKETPLACES = 'ATVPDKIKX0DER%2CA2EUQ1WTGCTBG2%2CA1AM78C64UM0Y8%2CA2Q3Y263D00KWC'; // US, CA, MX, BR
  const RETURNS_URLS = [
    `/manage/returns/mfn?~return_status=Approved%2CPendingLabel%2CPendingRefund%2CPendingApproval%2CCompleted&~return_request_date%3Adr=preset%2C90%2C90%2Cday&~marketplace_id=${RETURN_MARKETPLACES}`,
    `/gp/returns/list/v2?searchBy=undefined&searchString=null&marketplaceIds=${RETURN_MARKETPLACES}&tabId=undefined&returnRequestState=undefined&orderBy=CreatedDateDesc&selectedDateRange=90&pendingActionsFilterBy=null&isOnPendingActionsTab=false`,
  ]; // "coming up" in the summary = opens within this many days
  const MARKETPLACES = [
    [/amazon\.com\.mx/i, 'A1AM78C64UM0Y8'],
    [/amazon\.com\.br/i, 'A2Q3Y263D00KWC'],
    [/amazon\.ca/i, 'A2EUQ1WTGCTBG2'],
    [/amazon\.com/i, 'ATVPDKIKX0DER'],
  ];

  const ORDER_ID = /\b\d{3}-\d{7}-\d{7}\b/;
  const ORDER_ID_G = /\b\d{3}-\d{7}-\d{7}\b/g;
  const EXACT_ID = /^\s*(?:order\s*(?:id|number|#)?\s*[:#]?\s*)?#?\s*(\d{3}-\d{7}-\d{7})\s*$/i;
  const REQUEST_LABEL = /^request (?:a )?review$/i;
  const LEAF_TAGS = new Set(['SPAN', 'DIV', 'TD', 'P', 'STRONG', 'B', 'LABEL', 'KAT-LABEL', 'H1', 'H2', 'H3', 'H4', 'LI']);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const OUR_UI = '#nudge-pop, #nudge-toast, [data-nudge-ui], [data-nudge-id]';
  const INTERACTIVE = 'button, a, select, option, [role="button"], [role="link"], [role="menu"], [role="menuitem"], kat-button, kat-link, kat-dropdown';
  const FINAL_STATUSES = ['sent', 'already', 'skippedReturn', 'closed', 'unknown'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
  const addDays = (day, n) => {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() + n);
    return localDay(d);
  };
  const NBSP = '\u00a0'; // keeps "Sep 29 (4 orders)" together on one line
  const shortDate = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(/\s/g, NBSP);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Internal only: how orders are sent. 'fast' = the same request Amazon's Yes
  // button sends; 'page' = through Amazon's Request a Review page. Switches by itself.
  let settings = { method: 'fast', frameBlocked: false, v: 5 };
  let busy = false;
  let stopRequested = false;
  let progress = null; // { i, n } while sending the whole page
  let checkingReturns = false;
  let listSkips = 0; // orders marked from Manage Returns during the current run
  let returnsUnread = false; // Manage Returns couldn't be read during the current run
  let returnsList = null; // { at, ids: Set } from Manage Returns
  let attention = false; // something failed; red dot on the toolbar button
  const buttons = new Map(); // orderId -> pill
  const anchors = new Map(); // orderId -> the order number element
  const working = new Set();
  let lastStatuses = {};
  let launcher = null; // toolbar button
  let pop = null; // per-order popup (#nudge-pop)
  let popId = null;
  const frameLoader = realFrameLoader;

  const get = async (keys) => (await api.storage.local.get(keys)) || {};
  const send = (msg) => Promise.resolve(api.runtime.sendMessage(msg)).catch(() => null);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- when an order should open up ----------
  // Amazon's clock starts at DELIVERY (requests open 5 days after it), not at the
  // order date. We estimate delivery from the row:
  //   - "Deliver by" date (the latest promised delivery), else order date + a few days
  //   - "Delivered" shown in the row → delivery was today at the latest
  //   - "In transit" / "Out for delivery" → not delivered yet, so tomorrow at the earliest
  function opensOn(b) {
    const today = localDay();
    let delivery = b.dataset.nudgeDeliverBy || (b.dataset.nudgeDate ? addDays(b.dataset.nudgeDate, TYPICAL_TRANSIT_DAYS) : '');
    if (!delivery) return '';
    if (b.dataset.nudgeDelivery === 'delivered' && delivery > today) delivery = today;
    if (b.dataset.nudgeDelivery === 'inTransit' && delivery <= today) delivery = addDays(today, 1);
    return addDays(delivery, OPENS_AFTER_DELIVERY_DAYS);
  }
  // Last day Amazon allows a request: 30 days after the (latest possible) delivery.
  function closesOn(b) {
    const opens = opensOn(b);
    return opens ? addDays(opens, 30 - OPENS_AFTER_DELIVERY_DAYS) : '';
  }

  // ---------- what each pill says ----------
  const V = (label, kind, group, opts = {}) => ({ label, kind, group, final: !!opts.final, batch: !!opts.batch, act: !!opts.act });

  function viewOf(rec, b, today) {
    const orderDate = b ? b.dataset.nudgeDate : '';
    const opens = b ? opensOn(b) : '';
    const notOpenYet = !!opens && opens > today;
    const closes = b ? closesOn(b) : '';
    const age0 = orderDate ? daysBetween(orderDate, today) : null;
    const past = () => V('⊘ Past 30 days', 'past', 'past 30 days', { final: true });
    const isPast = (closes && today > closes) || (age0 !== null && age0 > TOO_OLD_DAYS);
    const waiting = () =>
      notOpenYet ? V(`Opens ~${shortDate(opens)}`, 'muted', 'not eligible yet') : V('Not eligible yet', 'muted', 'not eligible yet');
    // Ready to send: the estimated open date has passed (or there's nothing to estimate from).
    const ready = (retry) =>
      notOpenYet ? waiting() : V(retry ? 'Try again' : 'Request review', 'action', 'to send', { batch: true, act: true });
    if (rec && rec.status) {
      switch (rec.status) {
        case 'sent':
          return V('Sent ✓', 'ok', 'sent', { final: true });
        case 'already':
          return V('Already requested', 'muted', 'already requested', { final: true });
        case 'skippedReturn':
          return V(rec.returnKind === 'refund' ? '↩ Refunded · skipped' : '↩ Returned · skipped', 'returned', 'returns/refunds skipped', { final: true });
        case 'closed':
          return past();
        case 'unknown':
          return V('Needs a look', 'warn', 'need a look', { final: true });
        case 'notEligible':
          if (isPast || (!notOpenYet && age0 !== null && age0 > 30)) return past();
          if (rec.checkedDay === today) return waiting();
          break;
        case 'error':
          if (rec.checkedDay === today) return V('Error – tap', 'err', 'errors', { batch: true });
          break;
        default:
          break;
      }
      // Tried on an earlier day and not finished: try again once it should be open.
      if (isPast) return past();
      return ready(rec.status === 'notEligible');
    }
    const age = orderDate ? daysBetween(orderDate, today) : null;
    if (age !== null && age < OPENS_AFTER_DELIVERY_DAYS) return waiting();
    if (isPast) return past();
    return ready(false);
  }

  // Short explanation for the popup: title, one line, maybe a button.
  function explain(rec, b, today) {
    const s = rec && rec.status;
    const isToday = rec && rec.checkedDay === today;
    const opens = opensOn(b);
    const age = b.dataset.nudgeDate ? daysBetween(b.dataset.nudgeDate, today) : null;
    const openLine = opens && opens > today ? `Should open around ${shortDate(opens)} (5 days after delivery). ` : '';
    if (s === 'notEligible' && !isToday && !(opens && opens > today) && !(closesOn(b) && today > closesOn(b)) && !(age !== null && age > 30)) {
      return { tone: 'info', title: 'Try again', line: `Amazon said not eligible on ${shortDate(rec.checkedDay)}. It may be open now.`, action: 'Send review request' };
    }
    if (s === 'sent') return { tone: 'ok', title: '✓ Review requested', line: 'Amazon accepted the request.' };
    if (s === 'already') return { tone: 'muted', title: 'Already requested', line: 'Amazon already sent one for this order.' };
    if (s === 'skippedReturn') {
      return { tone: 'returned', title: rec.returnKind === 'refund' ? 'Refunded – skipped' : 'Returned – skipped', line: rec.detail };
    }
    const closes = closesOn(b);
    const pastNow = s === 'closed' || (s !== 'sent' && s !== 'already' && s !== 'skippedReturn' && ((closes && today > closes) || (age !== null && age > TOO_OLD_DAYS) || (s === 'notEligible' && !(opens && opens > today) && age !== null && age > 30)));
    if (pastNow) return { tone: 'muted', title: 'Past the 30-day window', line: `Amazon only allows requests up to 30 days after delivery${closes ? ` (last day ~${shortDate(closes)})` : ''}. This order can't be requested.` };
    if (s === 'unknown') return { tone: 'warn', title: 'Needs a look', line: "Couldn't confirm it went through. Check this order in Seller Central." };
    if (s === 'notEligible' && isToday) {
      return { tone: 'muted', title: 'Not eligible yet', line: `${openLine}It's included again next time you click Request Reviews.`, action: 'Try now' };
    }
    if (s === 'error' && isToday) return { tone: 'err', title: "Didn't go through", line: rec.detail, action: 'Try again' };
    if (!s && opens && opens > today) {
      return { tone: 'muted', title: 'Not eligible yet', line: `${openLine}Request Reviews picks it up once it opens.`, action: 'Try anyway' };
    }
    if (!s && age !== null && age < OPENS_AFTER_DELIVERY_DAYS) {
      return { tone: 'muted', title: 'Not eligible yet', line: 'Ordered less than 5 days ago. Request Reviews picks it up once it opens.', action: 'Try anyway' };
    }
    if (!s && age !== null && age > TOO_OLD_DAYS) return { tone: 'muted', title: 'Window closed', line: `Ordered ${age} days ago.`, action: 'Try anyway' };
    return { tone: 'info', title: 'Not sent yet', line: '', action: 'Send review request' };
  }

  // ---------- pills ----------
  const COLORS = {
    action: ['#fff4e5', '#8a4b00', '#f0b35c'],
    ok: ['#e6f4ea', '#1e6b34', '#9fd3ae'],
    muted: ['#f1f1f1', '#5f5f5f', '#d5d9d9'],
    warn: ['#fff3cd', '#7a5a00', '#e8cf7a'],
    err: ['#fdecea', '#a1261b', '#f1aaa3'],
    returned: ['#ffffff', '#b12704', '#b12704'],
    past: ['#e3e6e6', '#565959', '#bbbfbf'],
    busy: ['#eef2f7', '#333344', '#cfd6e0'],
  };

  // Inline styles, so pills look right even inside Amazon's shadow DOM.
  function paint(btn, view) {
    const [bg, fg, border] = COLORS[view.kind] || COLORS.muted;
    btn.textContent = view.label;
    btn.title = view.act ? 'Send the review request for this order' : 'Tap for details';
    Object.assign(btn.style, {
      margin: '0',
      padding: '0 10px',
      height: '22px',
      font: 'inherit',
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '20px',
      borderRadius: '100px',
      border: `1px ${view.kind === 'returned' ? 'dashed' : 'solid'} ${border}`,
      background: bg,
      color: fg,
      cursor: view.kind === 'busy' ? 'progress' : 'pointer',
      whiteSpace: 'nowrap',
      verticalAlign: 'middle',
      display: 'inline-block',
      boxShadow: btn.dataset.nudgeId === popId && pop && !pop.hidden ? '0 0 0 2px #007185' : 'none',
    });
  }

  function paintOne(btn) {
    const id = btn.dataset.nudgeId;
    if (working.has(id)) paint(btn, V('Sending…', 'busy', ''));
    else paint(btn, viewOf(lastStatuses[id], btn, localDay()));
  }

  async function repaintAll() {
    const { statuses = {} } = await get(['statuses']);
    lastStatuses = statuses;
    for (const btn of buttons.values()) if (btn.isConnected) paintOne(btn);
    renderLauncher();
    if (popId && pop && !pop.hidden) renderPop();
  }

  // ---------- finding orders and Amazon's toolbar (old and new layouts) ----------
  function* allElements() {
    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      for (const e of root.querySelectorAll('*')) {
        yield e;
        if (e.shadowRoot) stack.push(e.shadowRoot);
      }
    }
  }

  const labelOf = (e) => (e.getAttribute('label') || e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim();
  const fallbackUrl = (id) => `${location.origin}/orders-v3/order/${id}`;
  const isClickable = (e) => e.tagName === 'BUTTON' || e.tagName === 'KAT-BUTTON' || e.tagName === 'A' || e.getAttribute('role') === 'button';

  function scanPage() {
    const byText = [];
    const byHref = [];
    const byLeaf = [];
    const toolbar = {};
    let hasAmazonRequestButton = false;
    for (const e of allElements()) {
      if (e.closest(OUR_UI)) continue;
      const tag = e.tagName;
      if (tag === 'A' && e.hasAttribute('href')) {
        const href = e.getAttribute('href') || '';
        const text = (e.textContent || '').match(EXACT_ID);
        const inHref = href.match(ORDER_ID);
        if (text) byText.push([text[1], inHref && inHref[0] === text[1] ? new URL(href, location.href).href : fallbackUrl(text[1]), e]);
        else if (inHref && /order/i.test(href)) byHref.push([inHref[0], new URL(href, location.href).href, e]);
      } else if (LEAF_TAGS.has(tag) && e.childElementCount === 0 && !e.closest('a, button')) {
        const m = (e.textContent || '').match(EXACT_ID);
        if (m) byLeaf.push([m[1], fallbackUrl(m[1]), e]);
      }
      if (isClickable(e)) {
        const label = labelOf(e);
        if (REQUEST_LABEL.test(label)) hasAmazonRequestButton = true;
        if (/^refresh$/i.test(label) && !toolbar.refresh) toolbar.refresh = e;
        else if (/^set table preferences$/i.test(label) && !toolbar.prefs) toolbar.prefs = e;
      }
    }
    const rows = new Map();
    for (const [id, url, anchor] of [...byText, ...byHref, ...byLeaf]) {
      if (!rows.has(id)) rows.set(id, { id, url, anchor });
    }
    return { rows: [...rows.values()], hasAmazonRequestButton, toolbar };
  }

  function isListPage() {
    const p = (location.pathname + location.hash).toLowerCase();
    if (!p.includes('order')) return false;
    if (/\/order\/\d{3}-\d{7}-\d{7}/.test(p)) return false; // a single order's page
    return !/messaging|review|return|solicit/.test(p);
  }

  // Text with a space between elements ("Sep 25, 2026" + "Deliver by" must not become "2026Deliver").
  function spacedText(node, skipInteractive) {
    const parts = [];
    const doc = node.ownerDocument || document;
    const walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest(`${OUR_UI}, script, style`) || (skipInteractive && p.closest(INTERACTIVE))) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    return skipInteractive ? parts.join(' | ') : parts.join(' ');
  }

  function rowContainer(e) {
    const tr = e.closest('tr');
    if (tr) return tr;
    let node = e;
    for (let i = 0; i < 12; i++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (new Set(spacedText(parent).match(ORDER_ID_G) || []).size > 1) break;
      node = parent;
    }
    return node;
  }

  function parseDates(text) {
    const out = [];
    const push = (y, m, d) => {
      if (y < 100) y += 2000;
      const dt = new Date(y, m, d, 12);
      if (m >= 0 && dt.getMonth() === m && dt.getDate() === d) out.push(dt);
    };
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) push(+m[3], +m[1] - 1, +m[2]);
    for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(+m[1], +m[2] - 1, +m[3]);
    for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
      push(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
    }
    for (const m of text.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi)) {
      push(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]);
    }
    for (const m of text.matchAll(/\b(\d{1,3})\s+days?\s+ago\b/gi)) {
      const d = new Date();
      d.setDate(d.getDate() - +m[1]);
      push(d.getFullYear(), d.getMonth(), d.getDate());
    }
    return out;
  }

  // The order date is the earliest date shown in the order's row
  // (ship-by and deliver-by dates always come after it).
  function orderDateOf(e) {
    const now = Date.now();
    const dates = parseDates(spacedText(rowContainer(e))).filter(
      (d) => d.getTime() <= now + 86400000 && d.getTime() >= now - 400 * 86400000
    );
    if (!dates.length) return '';
    return localDay(new Date(Math.min(...dates.map((d) => d.getTime()))));
  }

  // The row's "Deliver by" date (the latest one, if it's a range).
  function deliverByOf(e) {
    const text = spacedText(rowContainer(e));
    const m = text.match(/deliver(?:y)?\s*(?:by|date)[^0-9a-z]*(?:date)?[:\s]*([\s\S]{0,60})/i);
    if (!m) return '';
    const dates = parseDates(m[1]);
    if (!dates.length) return '';
    return localDay(new Date(Math.max(...dates.map((d) => d.getTime()))));
  }

  // Delivered already, or still on its way? (from the row's status text, not links)
  function deliveryOf(e) {
    const text = spacedText(rowContainer(e), true);
    if (/\b(?:in transit|out for delivery|not yet delivered|awaiting delivery|delivery attempted|shipped,? not delivered)\b/i.test(text)) return 'inTransit';
    if (/\bdelivered\b/i.test(text)) return 'delivered';
    return '';
  }

  // A return/refund label shown in the order's row on the orders list.
  function rowReturn(id) {
    const a = anchors.get(id);
    if (!a || !a.isConnected || !globalThis.__nudgeFindReturn) return null;
    return globalThis.__nudgeFindReturn(spacedText(rowContainer(a), true));
  }

  function marketplaceFor(id) {
    const a = anchors.get(id);
    const text = a && a.isConnected ? spacedText(rowContainer(a)) : '';
    const m = text.match(/sales channel:?\s*(amazon\.[a-z.]+)/i);
    const channel = m ? m[1] : 'amazon.com';
    for (const [re, mp] of MARKETPLACES) if (re.test(channel)) return mp;
    return 'ATVPDKIKX0DER';
  }

  // ---------- toolbar button ----------
  function makeLauncher() {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'nudge-launcher';
    b.setAttribute('data-nudge-ui', '');
    b.innerHTML = '<span data-dot></span><span data-label>Request Reviews</span>';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy && progress) {
        stopRequested = true;
        renderLauncher();
      } else if (!busy) runBatch();
    });
    return b;
  }

  // Copy the look of Amazon's own toolbar button (e.g. "Refresh"), so ours matches.
  function styleLike(b, ref) {
    const s = {
      fontFamily: '"Amazon Ember", Arial, sans-serif',
      fontSize: '15px',
      fontWeight: '400',
      lineHeight: '20px',
      color: '#0f1111',
      backgroundColor: '#ffffff',
      border: '1px solid #888c8c',
      borderRadius: '100px',
      paddingLeft: '16px',
      paddingRight: '16px',
      height: '34px',
      marginLeft: '8px',
    };
    if (ref) {
      const src = (ref.shadowRoot && ref.shadowRoot.querySelector('button')) || ref;
      const cs = getComputedStyle(src);
      const ok = (v) => v && v !== 'auto' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)';
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'paddingLeft', 'paddingRight', 'height']) {
        if (ok(cs[k])) s[k] = cs[k];
      }
      if (cs.borderTopWidth && cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
        s.border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
      }
      const parent = ref.parentElement;
      const gap = parent ? parseFloat(getComputedStyle(parent).columnGap) : 0;
      const ml = parseFloat(getComputedStyle(ref).marginLeft);
      s.marginLeft = gap > 0 ? '0px' : ml > 0 ? `${ml}px` : '8px';
    }
    Object.assign(b.style, s, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      verticalAlign: 'middle',
      boxSizing: 'border-box',
      marginTop: '0',
      marginBottom: '0',
    });
  }

  function placeLauncher(toolbar) {
    if (!launcher) launcher = makeLauncher();
    const ref = toolbar.refresh || toolbar.prefs || null;
    if (ref) {
      if (!launcher.isConnected || launcher.previousElementSibling !== ref) {
        ref.insertAdjacentElement('afterend', launcher);
        styleLike(launcher, ref);
      }
      launcher.classList.remove('nudge-floating');
    } else if (!launcher.classList.contains('nudge-floating') || !launcher.isConnected) {
      document.body.appendChild(launcher);
      styleLike(launcher, null);
      launcher.classList.add('nudge-floating');
      Object.assign(launcher.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483000', marginLeft: '0', boxShadow: '0 2px 8px rgba(0,0,0,.15)' });
    }
    renderLauncher();
  }

  function renderLauncher() {
    if (!launcher) return;
    const label = launcher.querySelector('[data-label]');
    const dot = launcher.querySelector('[data-dot]');
    label.textContent =
      stopRequested && busy
        ? 'Stopping…'
        : checkingReturns
          ? 'Checking returns…'
          : busy && progress && !progress.n
          ? `Opening page ${progress.page} · Stop`
          : busy && progress
          ? `${progress.page > 1 ? `Page ${progress.page} · ` : ''}Sending ${progress.i} of ${progress.n} · Stop`
          : busy
            ? 'Sending…'
            : 'Request Reviews';
    const show = busy || attention;
    Object.assign(dot.style, {
      display: show ? 'inline-block' : 'none',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: attention && !busy ? '#cc0c39' : '#007185',
      animation: busy ? 'nudge-pulse 1s ease-in-out infinite' : 'none',
      flex: 'none',
    });
    launcher.title = busy && progress ? 'Click to stop after the current order' : 'Send review requests to every eligible order on this page';
  }

  // Last message, kept on the button (hover to see it).
  function setStatus(text) {
    if (!launcher) return;
    launcher.dataset.status = text;
  }

  // ---------- per-order popup ----------
  function placeUnder(box, anchor) {
    const r = anchor.getBoundingClientRect();
    box.style.visibility = 'hidden';
    box.hidden = false;
    const w = box.offsetWidth || 280;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    Object.assign(box.style, { position: 'absolute', left: `${left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 6}px` });
    box.style.visibility = '';
  }

  function buildPop() {
    if (pop && pop.isConnected) return;
    pop = el('div');
    pop.id = 'nudge-pop';
    pop.hidden = true;
    pop.innerHTML = `
      <div class="nudge-pop-head"><span class="nudge-pop-title"></span><button type="button" class="nudge-x" aria-label="Close">×</button></div>
      <div class="nudge-pop-line"></div>
      <button type="button" class="nudge-pop-action"></button>`;
    document.body.appendChild(pop);
    pop.querySelector('.nudge-x').addEventListener('click', closePop);
    pop.querySelector('.nudge-pop-action').addEventListener('click', () => {
      const id = popId;
      closePop();
      if (id) runFromUi(id);
    });
  }

  function renderPop() {
    const btn = buttons.get(popId);
    if (!btn) return closePop();
    const x = explain(lastStatuses[popId], btn, localDay());
    pop.dataset.tone = x.tone;
    pop.querySelector('.nudge-pop-title').textContent = x.title;
    pop.querySelector('.nudge-pop-line').textContent = x.line || '';
    const action = pop.querySelector('.nudge-pop-action');
    action.hidden = !x.action || busy;
    action.textContent = x.action || '';
  }

  function openPop(id) {
    buildPop();
    popId = id;
    renderPop();
    placeUnder(pop, buttons.get(id));
    for (const b of buttons.values()) paintOne(b);
  }
  function closePop() {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    const b = buttons.get(popId);
    popId = null;
    if (b) paintOne(b);
  }

  // ---------- page scan ----------
  function removeOurUi() {
    for (const b of buttons.values()) (b.parentElement && b.parentElement.hasAttribute('data-nudge-ui') ? b.parentElement : b).remove();
    buttons.clear();
    anchors.clear();
    if (launcher) launcher.remove();
    closePop();
  }

  function makeButton(row) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.nudgeId = row.id;
    b.dataset.nudgeUrl = row.url;
    b.dataset.nudgeDate = orderDateOf(row.anchor);
    b.dataset.nudgeDeliverBy = deliverByOf(row.anchor);
    b.dataset.nudgeDelivery = deliveryOf(row.anchor);
    paintOne(b);
    b.addEventListener('click', onRowClick);
    // Keep clicks from reaching Amazon's row (which might open the order).
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart']) b.addEventListener(type, (e) => e.stopPropagation());
    return b;
  }

  let scanning = false;
  async function scan() {
    if (scanning || !document.body) return;
    scanning = true;
    try {
      const onList = isListPage();
      const found = onList ? scanPage() : { rows: [], hasAmazonRequestButton: false, toolbar: {} };
      if (!onList || found.hasAmazonRequestButton || (!found.rows.length && !busy)) {
        if (!busy) removeOurUi();
        return;
      }
      placeLauncher(found.toolbar);
      let added = false;
      for (const row of found.rows) {
        anchors.set(row.id, row.anchor);
        const existing = buttons.get(row.id);
        if (existing && existing.isConnected) continue;
        const b = makeButton(row);
        // On its own line right under the order number, so every row lines up.
        const line = document.createElement('div');
        line.setAttribute('data-nudge-ui', '');
        Object.assign(line.style, { display: 'block', margin: '4px 0 2px', padding: '0', lineHeight: '22px', textAlign: 'left' });
        line.appendChild(b);
        if (/^(TD|TH|LI)$/.test(row.anchor.tagName)) row.anchor.appendChild(line);
        else row.anchor.insertAdjacentElement('afterend', line);
        buttons.set(row.id, b);
        added = true;
        // Returned/refunded according to the orders list itself: mark it right away.
        const ret = rowReturn(row.id);
        const rec = lastStatuses[row.id];
        if (ret && !(rec && FINAL_STATUSES.includes(rec.status))) {
          send({ type: 'markReturn', orderId: row.id, detail: `Orders list shows "${ret.phrase}".`, returnKind: ret.returnKind, orderDate: b.dataset.nudgeDate || null, closesOn: closesOn(b) || null });
        }
      }
      if (added) await repaintAll();
    } finally {
      scanning = false;
    }
  }

  // ---------- sending one order ----------
  function waitForResult(id, t0) {
    return new Promise((resolve) => {
      let done = false;
      const check = async () => {
        if (done) return;
        const { statuses = {} } = await get(['statuses']);
        const rec = statuses[id];
        if (rec && rec.checkedAt >= t0) finish(rec);
      };
      const onChange = (changes, area) => {
        if ((!area || area === 'local') && changes.statuses) check();
      };
      const poll = setInterval(check, 2000);
      const timer = setTimeout(async () => {
        await send({ type: 'abortJob', orderId: id });
        await check();
        finish({ status: 'error', fatal: true, detail: 'Timed out waiting for Amazon.' });
      }, RESULT_TIMEOUT_MS);
      function finish(rec) {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        api.storage.onChanged.removeListener(onChange);
        resolve(rec);
      }
      api.storage.onChanged.addListener(onChange);
      check();
    });
  }

  function notStarted(res) {
    const detail = !res
      ? "The extension didn't respond. Reload this page and try again."
      : res.reason === 'busy'
        ? 'Another order is still being processed (maybe in another tab). Try again in a minute.'
        : res.reason;
    return { status: 'error', fatal: true, detail, unrecorded: true };
  }

  const startJob = (id, b, mode) =>
    send({ type: 'runJob', job: { orderId: id, url: b.dataset.nudgeUrl, dryRun: false, orderDate: b.dataset.nudgeDate || null, closesOn: closesOn(b) || null, mode } });
  const reportJob = (result) => send({ type: 'jobResult', result });
  const stageJob = async (stage, note) => (await send({ type: 'stage', stage, note })) === true;

  // An invisible frame on this page for loading Amazon's own pages.
  function makeFrame() {
    const f = document.createElement('iframe');
    f.setAttribute('data-nudge-ui', '');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('tabindex', '-1');
    f.title = 'ReviewNudge (hidden)';
    // Amazon's page needs scripts and same-origin access; no popups, no dialogs,
    // and it can't navigate this page.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    Object.assign(f.style, { position: 'fixed', left: '0', top: '0', width: '1280px', height: '900px', opacity: '0', pointerEvents: 'none', border: '0', zIndex: '-1' });
    document.body.appendChild(f);
    return f;
  }

  // 'continue' once Amazon's page is readable; 'blocked' if Amazon refuses to be shown in a frame.
  function realFrameLoader(frame, url) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        frame.removeEventListener('load', onLoad);
        resolve(r);
      };
      const onLoad = () => {
        let href = '';
        try {
          const d = frame.contentDocument;
          if (!d) return finish('blocked');
          href = d.location ? d.location.href : '';
        } catch (e) {
          return finish('blocked'); // cross-origin: Amazon sent us elsewhere
        }
        if (!href || href === 'about:blank') return; // not our page yet
        finish(href.startsWith(`${location.origin}/`) ? 'continue' : 'blocked');
      };
      const timer = setTimeout(() => finish('blocked'), FRAME_LOAD_TIMEOUT_MS);
      frame.addEventListener('load', onLoad);
      frame.src = url;
    });
  }

  function frameIo(frame, startUrl) {
    let currentUrl = startUrl;
    return {
      frame: true,
      doc: () => {
        try {
          return frame.contentDocument;
        } catch (e) {
          return null;
        }
      },
      url: () => {
        try {
          const h = frame.contentDocument.location.href;
          return h && h !== 'about:blank' ? h : currentUrl;
        } catch (e) {
          return currentUrl;
        }
      },
      navigate: async (u) => {
        currentUrl = u;
        return frameLoader(frame, u);
      },
      setStage: stageJob,
      report: reportJob,
    };
  }

  // Every order on Manage Returns (any status: requested, pending, approved,
  // completed…), read in an invisible frame. { ok } or { ok: false, why }.
  // Seller Central's own "Manage Returns" link, if this page has one (works in
  // every region and uses the seller's own marketplaces).
  function menuReturnsUrl() {
    for (const e of allElements()) {
      if (e.tagName !== 'A' || e.closest(OUR_UI)) continue;
      const href = e.getAttribute('href') || '';
      if (!/return/i.test(href) || !/^manage (?:seller fulfilled )?returns$/i.test(labelOf(e))) continue;
      try {
        const u = new URL(href, location.href);
        if (u.origin === location.origin) return u.href;
      } catch (err) {
        /* not a usable link */
      }
    }
    return '';
  }

  async function readReturnsList() {
    const whys = [];
    const urls = [menuReturnsUrl(), ...RETURNS_URLS.map((p) => `${location.origin}${p}`)].filter((u, i, all) => u && all.indexOf(u) === i);
    for (const url of urls) {
      const frame = makeFrame();
      try {
        const io = frameIo(frame, url);
        if ((await io.navigate(url)) === 'blocked') {
          whys.push("the returns page couldn't be opened");
          continue;
        }
        const r = await Promise.race([
          globalThis.__nudgeReadReturns(io),
          sleep(RETURNS_READ_TIMEOUT_MS).then(() => ({ ok: false, why: 'the returns list took too long' })),
        ]);
        if (r.ok || r.blocked) return r; // a CAPTCHA or sign-in page: don't try again elsewhere
        whys.push(r.why);
      } catch (e) {
        whys.push(`unexpected problem: ${e && e.message}`);
      } finally {
        frame.remove();
      }
    }
    return { ok: false, why: whys[whys.length - 1] || 'unknown' };
  }

  // Makes sure the returns list is fresh, and marks matching orders on this page.
  async function ensureReturns() {
    if (returnsList && Date.now() - returnsList.at < RETURNS_REFRESH_MS) return { ok: !returnsList.failed, why: returnsList.failed };
    checkingReturns = true;
    renderLauncher();
    let r;
    try {
      r = await readReturnsList();
    } finally {
      checkingReturns = false;
      renderLauncher();
    }
    if (r.blocked) return { ok: false, blocked: true, why: r.why }; // Amazon wants a person: stop, don't cache
    if (!r.ok) {
      // Best effort: keep going without it; orders-page labels are still checked.
      returnsList = { at: Date.now(), ids: new Set(), failed: r.why };
      returnsUnread = true;
      return { ok: false, why: r.why };
    }
    returnsList = { at: Date.now(), ids: new Set(r.ids) };
    const { statuses = {} } = await get(['statuses']);
    let marked = 0;
    for (const [id, b] of buttons) {
      const rec = statuses[id];
      if (returnsList.ids.has(id) && !(rec && FINAL_STATUSES.includes(rec.status))) {
        marked++;
        if (b.isConnected && viewOf(rec, b, localDay()).batch) listSkips++;
        await send({ type: 'markReturn', orderId: id, detail: 'This order has a return request on Manage Returns.', returnKind: 'return', orderDate: b.dataset.nudgeDate || null, closesOn: closesOn(b) || null });
      }
    }
    await repaintAll();
    return { ok: true, marked };
  }

  const RETURNS_NOTE = "Manage Returns couldn't be read, so only returns shown on the orders page were skipped.";

  // Firefox runs content-script fetch() as the extension; content.fetch() sends
  // it as the page itself, like Chrome and Safari do by default.
  const pageFetch = (url, opts) =>
    globalThis.content && typeof globalThis.content.fetch === 'function' ? globalThis.content.fetch(url, opts) : fetch(url, opts);

  function csrfToken() {
    const m = document.querySelector('meta[name="anti-csrftoken-a2z"], meta[name*="csrf" i]');
    return m ? m.getAttribute('content') : '';
  }

  // The same request Amazon's "Yes" button sends on its Request a Review page.
  async function postReviewRequest(id) {
    const url = `${location.origin}/messaging/api/solicitations/${encodeURIComponent(id)}/productReviewAndSellerFeedback?marketplaceId=${marketplaceFor(id)}&isReturn=false`;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const token = csrfToken();
    if (token) headers['anti-csrftoken-a2z'] = token;
    let resp;
    try {
      resp = await pageFetch(url, { method: 'POST', credentials: 'include', headers, body: '{}', redirect: 'manual' });
    } catch (e) {
      return { notProcessed: true, why: 'no response' };
    }
    if (resp.type === 'opaqueredirect' || resp.status === 0 || (resp.status >= 300 && resp.status < 400)) {
      return { notProcessed: true, why: 'Amazon redirected the request' };
    }
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      /* not JSON */
    }
    if (data && data.isSuccess === true) return { status: 'sent', detail: 'Amazon accepted the review request.' };
    const reason = data && typeof data.ineligibleReason === 'string' ? data.ineligibleReason : '';
    if (/ALREADY/i.test(reason)) return { status: 'already', detail: 'Amazon already sent one for this order.' };
    if (reason) {
      const words = reason.replace(/^REVIEW_REQUEST_/, '').replace(/_/g, ' ').toLowerCase();
      return { status: 'notEligible', detail: /WINDOW/i.test(reason) ? "Outside Amazon's 5–30 day window" : `Amazon: ${words}` };
    }
    return { notProcessed: true, why: `Amazon answered ${resp.status}` };
  }

  let fastFailures = 0;

  async function saveSettings() {
    await api.storage.local.set({ settings });
  }

  async function rememberFrameBlocked() {
    if (settings.frameBlocked) return;
    settings.frameBlocked = true;
    settings.switchedDay = localDay();
    await saveSettings();
  }

  // Quick send: the same request Amazon's Yes button sends.
  async function runFast(id, b) {
    const t0 = Date.now();
    const res = await startJob(id, b, 'fast');
    if (!res || !res.ok) return notStarted(res);

    const rowRet = rowReturn(id);
    if (rowRet) {
      await reportJob({ status: 'skippedReturn', detail: `Orders list shows "${rowRet.phrase}".`, returnKind: rowRet.returnKind });
      return waitForResult(id, t0);
    }
    // Returns were already ruled out by Manage Returns (runOne) and the row's own label.

    // Recorded before sending, so a request is never sent twice by accident.
    if (!(await stageJob('confirmPage')) || !(await stageJob('clickedYes'))) {
      await reportJob({ status: 'error', fatal: true, notProcessed: true, detail: 'Lost contact with the extension. Nothing was sent.' });
      return waitForResult(id, t0);
    }
    const r = await postReviewRequest(id);
    if (r.notProcessed) {
      await reportJob({ status: 'error', notProcessed: true, detail: `Quick send didn't work (${r.why}).` });
      await waitForResult(id, t0);
      if (++fastFailures >= 2 && settings.method === 'fast') {
        settings.method = 'page';
        settings.switchedDay = localDay();
        await saveSettings();
      }
      return { usePage: true };
    }
    fastFailures = 0;
    await reportJob(r);
    return waitForResult(id, t0);
  }

  // Amazon's pages in a background tab.
  async function runInTab(id, b) {
    const t0 = Date.now();
    const res = await startJob(id, b, 'tab');
    if (!res || !res.ok) return notStarted(res);
    return waitForResult(id, t0);
  }

  // Amazon's pages in the invisible frame: order page → Request a Review page → Yes.
  async function runInFrame(id, b) {
    const t0 = Date.now();
    const res = await startJob(id, b, 'frame');
    if (!res || !res.ok) return notStarted(res);
    const frame = makeFrame();
    const io = frameIo(frame, b.dataset.nudgeUrl);
    let outcome;
    try {
      const first = await io.navigate(b.dataset.nudgeUrl);
      outcome =
        first === 'blocked'
          ? 'blocked'
          : await Promise.race([
              globalThis.__nudgeDrive({ orderId: id, dryRun: false, stage: 'start' }, io),
              sleep(RESULT_TIMEOUT_MS).then(() => 'timeout'),
            ]);
    } catch (e) {
      await reportJob({ status: 'error', detail: `Unexpected problem: ${e && e.message}` });
    } finally {
      frame.remove();
    }
    if (outcome === 'blocked') {
      await rememberFrameBlocked();
      if (await send({ type: 'cancelJob', orderId: id })) return { useTab: true };
    }
    if (outcome === 'timeout') await send({ type: 'abortJob', orderId: id });
    return waitForResult(id, t0);
  }

  // Picks the best working way automatically: quick send → Amazon's page
  // (invisible) → Amazon's page in a background tab.
  async function runOne(id) {
    const b = buttons.get(id);
    if (!b) return { status: 'error', detail: 'Order is no longer on the page.', unrecorded: true };
    if (!b.dataset.nudgeDate && anchors.get(id)) b.dataset.nudgeDate = orderDateOf(anchors.get(id));
    working.add(id);
    closePop();
    await repaintAll();
    // Best effort: an unreadable list doesn't stop sending. A CAPTCHA or sign-in page does.
    const ret = await ensureReturns();
    if (ret.blocked) {
      working.delete(id);
      await repaintAll();
      return { status: 'error', fatal: true, unrecorded: true, detail: `${ret.why} while reading Manage Returns, so ReviewNudge stopped. Nothing more was sent.` };
    }
    if (returnsList.ids.has(id)) {
      working.delete(id);
      await send({ type: 'markReturn', orderId: id, detail: 'This order has a return request on Manage Returns.', returnKind: 'return', orderDate: b.dataset.nudgeDate || null, closesOn: closesOn(b) || null });
      await repaintAll();
      const { statuses = {} } = await get(['statuses']);
      return statuses[id] || { status: 'skippedReturn', returnKind: 'return' };
    }
    let rec = settings.method === 'fast' ? await runFast(id, b) : { usePage: true };
    if (rec.usePage) rec = settings.frameBlocked ? { useTab: true } : await runInFrame(id, b);
    if (rec.useTab) rec = await runInTab(id, b);
    working.delete(id);
    await repaintAll();
    return rec;
  }

  function showOrder(id) {
    const b = buttons.get(id);
    if (!b || !b.isConnected) return;
    const r = b.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) b.scrollIntoView({ block: 'center' });
    openPop(id);
  }

  // Green pill on success; red pill + popup + notice on trouble.
  function announce(id, rec, single) {
    if (rec.unrecorded) {
      attention = true;
      renderLauncher();
      setStatus(rec.detail);
      notice(rec.detail, 'err');
      return;
    }
    if (rec.status === 'sent') {
      if (single) notice('Review requested ✓', 'ok');
    } else if (rec.status === 'error' || rec.status === 'unknown') {
      attention = true;
      renderLauncher();
      showOrder(id);
      notice(`Order ${id} didn't go through. Tap to see why.`, 'err', () => showOrder(id));
    } else if (single) {
      showOrder(id); // not eligible / returned / already requested: say why
    }
  }

  async function runFromUi(id) {
    if (busy) return notice('Busy – wait for the current order to finish.', 'info');
    const b = buttons.get(id);
    if (!b) return;
    const { statuses = {} } = await get(['statuses']);
    lastStatuses = statuses;
    if (viewOf(statuses[id], b, localDay()).final) return openPop(id);
    busy = true;
    renderLauncher();
    let rec;
    try {
      rec = await runOne(id);
    } finally {
      busy = false;
      renderLauncher();
    }
    setStatus(`Order ${id}: ${viewOf(rec.checkedDay ? rec : { ...rec, checkedDay: localDay() }, b, localDay()).label}`);
    announce(id, rec, true);
  }

  async function onRowClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const b = e.currentTarget;
    const id = b.dataset.nudgeId;
    if (working.has(id)) return;
    const v = viewOf(lastStatuses[id], b, localDay());
    if (v.act && !busy) return runFromUi(id);
    if (popId === id && pop && !pop.hidden) return closePop();
    openPop(id); // explain the result instead of re-running it
  }

  // ---------- notices at the bottom of the screen ----------
  let toast = null;
  let toastTimer = null;
  function notice(text, tone, onClick, sticky) {
    if (!toast || !toast.isConnected) {
      toast = el('div');
      toast.id = 'nudge-toast';
      toast.setAttribute('data-nudge-ui', '');
      toast.setAttribute('role', 'status');
      toast.innerHTML = '<span class="nudge-toast-text"></span><button type="button" class="nudge-x" aria-label="Close">×</button>';
      document.body.appendChild(toast);
      toast.querySelector('.nudge-x').addEventListener('click', (e) => {
        e.stopPropagation();
        toast.hidden = true;
      });
    }
    // One sentence per line, so a new sentence never continues a line.
    const box = toast.querySelector('.nudge-toast-text');
    box.textContent = '';
    for (const sentence of String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(↩])/)) {
      box.appendChild(el('span', 'nudge-toast-line', sentence));
    }
    toast.dataset.tone = tone || 'info';
    toast.onclick = onClick
      ? () => {
          toast.hidden = true;
          onClick();
        }
      : null;
    toast.style.cursor = onClick ? 'pointer' : 'default';
    toast.hidden = false;
    clearTimeout(toastTimer);
    toast.classList.remove('nudge-fade');
    toastTimer = setTimeout(() => {
      toast.classList.add('nudge-fade');
      toastTimer = setTimeout(() => { toast.hidden = true; toast.classList.remove('nudge-fade'); }, 600);
    }, tone === 'err' ? 15000 : sticky ? 12000 : 6000);
  }

  // ---------- every eligible order, page after page ----------
  // Orders that haven't opened yet, grouped by the day they should open.
  // `seen` (order → day) collects them across pages during one run.
  function noteUpcoming(seen) {
    const today = localDay();
    for (const [id, b] of buttons) {
      if (!b.isConnected) continue;
      if (viewOf(lastStatuses[id], b, today).group !== 'not eligible yet') continue;
      const opens = opensOn(b);
      if (opens) seen.set(id, opens <= today ? addDays(today, 1) : opens);
    }
    return seen;
  }
  function comingUp(seen = noteUpcoming(new Map())) {
    const byDay = {};
    for (const day of seen.values()) byDay[day] = (byDay[day] || 0) + 1;
    const days = Object.keys(byDay).sort();
    if (!days.length) return '';
    const part = (d) => `${shortDate(d)}${NBSP}(${plural(byDay[d], 'order').replace(' ', NBSP)})`;
    return `Next batch: ${part(days[0])}${days[1] ? `, then ${part(days[1])}` : ''}.`;
  }

  const ONE = { 'returns/refunds skipped': 'return/refund skipped', errors: 'error' };
  function summary(tally) {
    const order = ['sent', 'not eligible yet', 'returns/refunds skipped', 'already requested', 'past 30 days', 'need a look', 'errors'];
    return order
      .filter((k) => tally[k])
      .map((k) => (k === 'sent' ? `Sent ${tally[k]}` : `${tally[k]} ${tally[k] === 1 ? ONE[k] || k : k}`))
      .join(' · ');
  }

  const pageIds = () => [...buttons].filter(([, b]) => b.isConnected).map(([id]) => id);

  // Amazon's own "Next" page button, if there is one and it's enabled.
  function findNextPage() {
    for (const e of allElements()) {
      if (e.closest(OUR_UI) || !isClickable(e)) continue;
      const label = labelOf(e);
      if (!/^next\b/i.test(label) && !/^next page$/i.test(e.getAttribute('aria-label') || '')) continue;
      if (e.disabled || e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true' || e.closest('.a-disabled, [aria-disabled="true"]')) continue;
      return e;
    }
    return null;
  }

  // Clicks Next and waits for a different set of orders to appear.
  async function goToNextPage() {
    const next = findNextPage();
    if (!next) return false;
    const before = pageIds().join(',');
    const inner = next.shadowRoot && next.shadowRoot.querySelector('button, a');
    (inner || next).click();
    const end = Date.now() + NEXT_PAGE_TIMEOUT_MS;
    let last = '';
    let since = 0;
    while (Date.now() < end) {
      await sleep(POLL_PAGE_MS);
      await scan();
      const now = pageIds().join(',');
      if (!now || now === before) continue;
      if (now !== last) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= PAGE_SETTLE_MS) return true;
    }
    return null; // clicked, but no new orders showed up
  }

  // Newest-first list: once a page has an order past 30 days, every later page is older still.
  function pageReachedOldOrders() {
    const today = localDay();
    return [...buttons.values()].some((b) => b.isConnected && viewOf(lastStatuses[b.dataset.nudgeId], b, today).group === 'past 30 days');
  }

  async function runBatch() {
    if (busy) return;
    busy = true;
    stopRequested = false;
    attention = false;
    closePop();
    listSkips = 0;
    returnsUnread = false;
    if (returnsList && returnsList.failed) returnsList = null; // try again on each new run
    const tally = {};
    const upcoming = new Map();
    let errorsInARow = 0;
    let stopReason = '';
    let page = 1;
    let pagesNote = '';
    try {
      for (;;) {
        await scan();
        const { statuses = {} } = await get(['statuses']);
        lastStatuses = statuses;
        const plan = pageIds().filter((id) => viewOf(statuses[id], buttons.get(id), localDay()).batch);
        for (let i = 0; i < plan.length; i++) {
          if (stopRequested) break;
          const id = plan[i];
          const { statuses: now = {} } = await get(['statuses']);
          const b = buttons.get(id);
          if (!b || viewOf(now[id], b, localDay()).final) continue; // handled meanwhile

          progress = { i: i + 1, n: plan.length, page };
          renderLauncher();
          const rec = await runOne(id);
          const group = viewOf(rec.checkedDay ? rec : { ...rec, checkedDay: localDay() }, b, localDay()).group;
          if (!rec.unrecorded) tally[group] = (tally[group] || 0) + 1;

          if (rec.fatal) {
            announce(id, rec, false);
            stopReason = rec.unrecorded ? `Stopped. ${rec.detail}` : `Stopped at order ${id}.`;
            break;
          }
          if (rec.status === 'error') {
            if (++errorsInARow >= 2) {
              announce(id, rec, false);
              stopReason = 'Stopped after 2 errors in a row.';
              break;
            }
          } else {
            errorsInARow = 0;
          }
          if (i < plan.length - 1 && !stopRequested) await sleep(rand(GAP_MIN_MS, GAP_MAX_MS));
        }
        const { statuses: after = {} } = await get(['statuses']);
        lastStatuses = after;
        noteUpcoming(upcoming);
        if (stopRequested && !stopReason) stopReason = 'Stopped.';
        if (stopReason) break;

        // Next page, while this page still had orders inside the 30-day window.
        if (pageReachedOldOrders() || page >= MAX_PAGES || !findNextPage()) break;
        progress = { i: 0, n: 0, page: page + 1 };
        renderLauncher();
        await sleep(rand(GAP_MIN_MS, GAP_MAX_MS));
        if (stopRequested) {
          stopReason = 'Stopped.';
          break;
        }
        const moved = await goToNextPage();
        if (!moved) {
          stopReason = "Stopped: the next page of orders didn't load.";
          break;
        }
        page++;
        pagesNote = ` across ${plural(page, 'page')}`;
      }
    } finally {
      busy = false;
      progress = null;
      stopRequested = false;
      await repaintAll();
      if (listSkips) tally['returns/refunds skipped'] = (tally['returns/refunds skipped'] || 0) + listSkips;
      const done = summary(tally);
      const text = `${stopReason ? `${stopReason} ` : done ? 'Done. ' : ''}${done ? `${done}${pagesNote}.` : 'Nothing to send right now.'} ${comingUp(upcoming)} ${returnsUnread ? RETURNS_NOTE : ''}`.replace(/ {2,}/g, ' ').trim(); // plain spaces only: dates keep their no-break spaces
      setStatus(text);
      if (!stopReason || stopReason === 'Stopped.') notice(text, tally.sent ? 'ok' : 'info', null, true);
      renderLauncher();
    }
  }

  // ---------- start ----------
  async function init() {
    const stored = await get(['settings', 'statuses']);
    const saved = stored.settings || {};
    // Older versions had user settings; v0.5 has none (everything is automatic).
    // A fallback lasts for the day it was needed; each new day starts with the quick send again.
    const keep = saved.v === 5 && saved.switchedDay === localDay();
    settings = {
      method: keep && saved.method === 'page' ? 'page' : 'fast',
      frameBlocked: keep && !!saved.frameBlocked,
      switchedDay: keep ? saved.switchedDay : '',
      v: 5,
    };
    lastStatuses = stored.statuses || {};
    await scan();

    let pending = null;
    const schedule = () => {
      clearTimeout(pending);
      pending = setTimeout(scan, 500);
    };
    const ours = (node) => node.nodeType === 1 && !!node.closest(OUR_UI);
    new MutationObserver((records) => {
      if (records.every((r) => ours(r.target))) return; // our own updates
      schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);
    setInterval(scan, RESCAN_MS); // catches changes inside Amazon's shadow DOM

    // Close the popup when clicking elsewhere or pressing Escape.
    document.addEventListener(
      'mousedown',
      (e) => {
        const path = e.composedPath ? e.composedPath() : [e.target];
        if (pop && !pop.hidden && !path.includes(pop) && !path.some((n) => n && n.dataset && n.dataset.nudgeId)) closePop();
      },
      true
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePop();
    });
    window.addEventListener('resize', closePop);

    let repaintPending = null;
    api.storage.onChanged.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if (changes.settings && changes.settings.newValue && changes.settings.newValue.v === 5) {
        settings = { ...settings, ...changes.settings.newValue };
      }
      clearTimeout(repaintPending);
      repaintPending = setTimeout(repaintAll, 150);
    });
  }

  init();
})();

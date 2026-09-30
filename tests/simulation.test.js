// End-to-end simulation: fake Safari (tabs, storage, messaging, background
// restarts) + fake Seller Central (orders list, order pages, review page).
// Counts every press of Amazon's "Yes" so we can prove what was sent.
const fs = require('fs');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const path = require('path');
const EXT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(`${EXT}/${f}`, 'utf8');
function speed(src, pairs) {
  for (const [a, b] of pairs) {
    if (!src.includes(a)) throw new Error(`test setup: "${a}" not found`);
    src = src.split(a).join(b);
  }
  return src;
}
const WORKER = speed(read('content/amazon-pages.js'), [
  ['POLL_MS = 400', 'POLL_MS = 15'],
  ['BUTTON_WAIT_MS = 10000', 'BUTTON_WAIT_MS = 500'],
  ['STAGE_TIMEOUT_MS = 30000', 'STAGE_TIMEOUT_MS = 1200'],
  ['SETTLE_MS = 3000', 'SETTLE_MS = 150'],
  ['STEP_DELAY_MIN_MS = 1500', 'STEP_DELAY_MIN_MS = 15'],
  ['STEP_DELAY_MAX_MS = 3000', 'STEP_DELAY_MAX_MS = 30'],
  ['HELLO_RETRY_MS = 500', 'HELLO_RETRY_MS = 25'],
  ['RETURNS_LOAD_MS = 25000', 'RETURNS_LOAD_MS = 1000'],
  ['RETURNS_SETTLE_MS = 1500', 'RETURNS_SETTLE_MS = 60'],
  ['RETURNS_PAGE_MS = 15000', 'RETURNS_PAGE_MS = 600'],
  ['location.assign(url)', 'window.__nav(url)'],
]);
const ORDERS = speed(read('content/orders-page.js'), [
  ['GAP_MIN_MS = 3000', 'GAP_MIN_MS = 20'],
  ['GAP_MAX_MS = 6000', 'GAP_MAX_MS = 40'],
  ['RESULT_TIMEOUT_MS = 60000', 'RESULT_TIMEOUT_MS = 5000'],
  ['RESCAN_MS = 3000', 'RESCAN_MS = 150'],
  ['setInterval(check, 2000)', 'setInterval(check, 100)'],
  ['const frameLoader = realFrameLoader;', 'const frameLoader = (f, u) => window.__nudgeFrameLoader(f, u);'],
  ['FRAME_LOAD_TIMEOUT_MS = 25000', 'FRAME_LOAD_TIMEOUT_MS = 1000'],
]);
const BG = speed(read('background.js'), [['STALE_JOB_MS = 4 * 60 * 1000', 'STALE_JOB_MS = 7000']]);

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const us = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (d) => `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const MP = 'ATVPDKIKX0DER';

let unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.stack) || e)));

// ---------------- fake Seller Central ----------------
// Delivery status shown in a row: explicit, or "Delivered to buyer" once the deliver-by date has passed.
function deliveryBadge(o) {
  if (o.status === 'inTransit') return '<span class="badge">In transit</span>';
  if (o.status === 'delivered' || (o.status === undefined && o.age - (o.transit ?? 4) >= 0)) return '<span class="badge">Delivered to buyer</span>';
  return '';
}
class Site {
  constructor(orders, layout = 'table') {
    this.orders = orders; // id -> scenario
    this.layout = layout;
    this.returns = []; // order ids listed on Manage Returns
    this.returnsLayout = 'new'; // 'new' | 'newBroken' (falls back to classic) | 'login'
    this.classicNext = true; // classic "Next" button works
    this.classicSizes = true; // classic has the 10/25/50 per-page menu
  }
  newReturns() {
    if (this.returnsLayout === 'captcha') return { html: '<p>Enter the characters you see below</p>' };
    if (this.returnsLayout === 'login') return { html: '<h1>Sign in</h1><input type="password">' };
    if (this.returnsLayout !== 'new') return { html: '<h1>Something went wrong</h1>' };
    const rows = this.returns.map((id) => `<tr><td>US</td><td><a href="#">${id}</a><br>Pat</td><td><span>Pending refund</span></td></tr>`).join('');
    const fbaLink = this.fbaVia === 'link' ? '<a href="/manage/returns/afn">View FBA Returns</a>' : '';
    const fbaMenu = this.fbaVia === 'menu' ? '<button id="ful">Seller fulfilled</button><div id="fulmenu" hidden><button id="afn">Fulfilled by Amazon</button></div>' : '';
    return {
      html: `${fbaMenu}<h1>Manage returns <span>(${this.returns.length})</span></h1>${fbaLink}<table>${rows}</table>`,
      script: (w) => {
        const b = w.document.getElementById('ful');
        if (!b) return;
        b.addEventListener('click', () => (w.document.getElementById('fulmenu').hidden = false));
        w.document.getElementById('afn').addEventListener('click', () => w.__nav('/manage/returns/afn'));
      },
    };
  }
  fbaPage() {
    const site = this;
    return {
      html: '<nav>Orders › Manage returns › Manage FBA returns</nav><h1>FBA Returns</h1><div id="fba"></div>',
      script: (w, env) => {
        let days = 30;
        let byAuth = false;
        const draw = () => {
          // Refund-date filter hides returns not refunded yet; authorized-date filter shows them.
          const list = (site.fbaReturns || []).filter((r) => r.days <= days && (byAuth || r.refunded !== false));
          const auth = site.fbaAuthFilter ? `<select id="basis"><option value="ref">Customer refunded date</option><option value="auth" ${byAuth ? 'selected' : ''}>Return authorized date</option></select>` : '';
          w.document.getElementById('fba').innerHTML =
            `<div>${auth}<label><input type="radio" name="d" ${days === 30 ? 'checked' : ''}>Last 30 days</label><label id="d90"><input type="radio" name="d" ${days === 90 ? 'checked' : ''}>Last 90 days</label><label id="d365"><input type="radio" name="d" ${days === 365 ? 'checked' : ''}>Last year</label></div>` +
            (site.fbaEmptyText && !list.length ? `<div>${site.fbaEmptyText}</div>` : `<span>${list.length} items</span>`) + `<table><tr><th>Order ID</th><th>Customer refunded date</th><th>Disposition</th></tr>` +
            list.map((r) => `<tr><td><a href="#">${r.id}</a></td><td>${r.days} days ago</td><td>SELLABLE</td></tr>`).join('') + '</table>';
          w.document.querySelector('#d90 input').addEventListener('click', () => { days = 90; setTimeout(draw, 20); });
          w.document.querySelector('#d365 input').addEventListener('click', () => { days = 365; env.fbaWide = true; setTimeout(draw, 20); });
          const basis = w.document.getElementById('basis');
          if (basis) basis.addEventListener('change', () => { byAuth = basis.value === 'auth'; env.fbaAuth = byAuth; setTimeout(draw, 20); });
        };
        draw();
      },
    };
  }
  classicReturns() {
    if (this.returnsLayout === 'down') return { html: '<h1>Something went wrong</h1>' };
    if (this.returnsLayout === 'captcha') return { html: '<p>Enter the characters you see below</p>' };
    if (this.returnsLayout === 'login') return { html: '<h1>Sign in</h1><input type="password">' };
    const site = this;
    return {
      html: '<h1>Manage Seller Fulfilled Returns</h1><div id="list"></div>',
      script: (w, env) => {
        let page = 0;
        let size = 10;
        const draw = () => {
          const all = site.returns;
          const rows = all.slice(page * size, page * size + size).map((id) => `<div class="row"><b>Order ID:</b> <a href="#">${id}</a> <span>Auto-authorized</span></div>`).join('');
          const last = (page + 1) * size >= all.length;
          const sizes = site.classicSizes ? '<select id="size"><option>10</option><option>25</option><option>50</option></select>' : '';
          w.document.getElementById('list').innerHTML = `<div>Total Returns: ${all.length}</div>${rows}<div>Showing Returns: ${page * size + 1}-${Math.min(all.length, (page + 1) * size)}</div><button id="prev">Prev</button><button id="next" ${last ? 'disabled' : ''}>Next</button>${sizes}`;
          const sel = w.document.getElementById('size');
          if (sel) {
            sel.value = String(size);
            sel.addEventListener('change', () => { size = parseInt(sel.value, 10); page = 0; env.sizeChanged = size; setTimeout(draw, 20); });
          }
          w.document.getElementById('next').addEventListener('click', () => {
            if (!site.classicNext) return;
            page++;
            env.returnPages = (env.returnPages || 0) + 1;
            setTimeout(draw, 20);
          });
        };
        setTimeout(draw, 20);
      },
    };
  }
  render(url) {
    const u = new URL(url);
    if (u.pathname.startsWith('/orders-v3/order/')) return this.orderPage(u.pathname.split('/').pop());
    if (u.pathname === '/messaging/reviews') return this.reviewPage(u.searchParams.get('orderId'));
    if (u.pathname === '/messaging/reviews/done')
      return { html: '<p>A review will be requested for this order. (Note: We will suppress this request if a review has already been requested for this order)</p>' };
    if (u.pathname === '/returns/region-menu') {
      this.menuHit = true;
      return { html: `<h1>Manage returns <span>(${this.returns.length})</span></h1><table>${this.returns.map((i) => `<tr><td><a href="#">${i}</a></td></tr>`).join('')}</table>` };
    }
    if (u.pathname === '/manage/returns/afn') return this.fbaPage();
    if (u.pathname.startsWith('/manage/returns')) return this.newReturns();
    if (u.pathname.startsWith('/gp/returns/list')) return this.classicReturns();
    if (u.pathname.startsWith('/orders-v3')) return this.listPage();
    return { html: '<h1>Not found</h1>' };
  }
  listRows(ids) {
    return ids
        .map((id) => {
          const o = this.orders[id];
          return `<tr><td>${us(daysAgo(o.age))}<br>3:14 PM PDT</td>
            <td>${this.layout === 'tdtext' ? id : `<a href="/orders-v3/order/${id}">${id}</a>`}</td><td><div>Buyer name: Pat</div><div>Sales channel: ${o.channel || 'Amazon.com'}</div><a href="#">Some product that was returned to us? no</a></td><td>${o.rowText || ''}</td>
            <td>Shipped<br>Ship by: ${us(daysAgo(o.age - 2))}${o.noDeliverBy ? '' : `<br>Deliver by date: ${longDate(daysAgo(o.age - (o.transit ?? 4)))} PDT`}</td>
            <td>${deliveryBadge(o)}</td></tr>`;
        })
        .join('');
  }
  listPage() {
    let ids = Object.keys(this.orders);
    if (this.pageSize) {
      // Newest first, a page at a time, Amazon-style pagination under the table.
      const site = this;
      const sorted = ids.sort((a, b) => this.orders[a].age - this.orders[b].age);
      const pageOf = (n) => sorted.slice(n * site.pageSize, (n + 1) * site.pageSize);
      return {
        html: `<h1>Manage Orders</h1><div class="bar" style="display:flex;gap:10px"><button>Set Table Preferences</button><button id="refresh">Refresh</button></div><div id="tbl"></div>`,
        script: (w, env) => {
          let n = 0;
          const draw = () => {
            const last = (n + 1) * site.pageSize >= sorted.length;
            w.document.getElementById('tbl').innerHTML = `<table><tr><th>Order date</th><th>Order details</th></tr>${site.listRows(pageOf(n))}</table><ul class="a-pagination"><li class="a-last${last ? ' a-disabled' : ''}"><a href="#">Next<span>→</span></a></li></ul>`;
            w.document.querySelector('.a-last a').addEventListener('click', (e) => {
              e.preventDefault();
              if (last) return;
              n++;
              env.listPages = (env.listPages || 0) + 1;
              setTimeout(draw, 30);
            });
          };
          draw();
        },
      };
    }
    if (this.layout === 'table' || this.layout === 'tdtext') {
      const rows = this.listRows(ids);
      const toolbar = `<div class="bar" style="display:flex;gap:10px"><button class="dark">Hide Filters</button><span>${ids.length} orders</span>
        <button>Set Table Preferences</button><button id="refresh">Refresh</button></div>`;
      const menu = this.menuReturns ? '<nav><a href="/returns/region-menu?mp=all">Manage Returns</a></nav>' : '';
      return { html: `${menu}<h1>Manage Orders</h1>${toolbar}<table><tr><th>Order date</th><th>Order details</th><th>Status</th></tr>${rows}</table>` };
    }
    // "New" layout: cards inside a shadow root, order IDs as plain text, clickable cards.
    return {
      html: '<h1>Orders</h1><order-list></order-list>',
      script: (w, env) => {
        const self = this;
        w.customElements.define(
          'order-list',
          class extends w.HTMLElement {
            connectedCallback() {
              const root = this.attachShadow({ mode: 'open' });
              for (const id of Object.keys(self.orders)) {
                const card = w.document.createElement('div');
                card.className = 'card';
                card.innerHTML = `<div class="top"><span>Order # ${id}</span></div><div>Purchased ${longDate(daysAgo(self.orders[id].age))}</div><div>Deliver by ${longDate(daysAgo(self.orders[id].age - 4))}</div>`;
                card.addEventListener('click', () => (env.cardClicks = (env.cardClicks || 0) + 1));
                root.appendChild(card);
              }
            }
          }
        );
      },
    };
  }
  orderPage(id) {
    const o = this.orders[id];
    if (!o) return { html: '<h1>Order not found</h1>' };
    const reviewUrl = `/messaging/reviews?orderId=${id}&marketplaceId=${MP}`;
    const req = {
      link: `<a href="${reviewUrl}"><kat-button label="Request a Review"></kat-button></a>`,
      js: '<kat-button id="rr" label="Request a Review"></kat-button>',
      newtab: '<kat-button id="rr" label="Request a Review"></kat-button>',
      modal: '<kat-button id="rr" label="Request a Review"></kat-button><div id="modal"></div>',
      none: '',
      disabled: '<kat-button label="Request a Review" disabled></kat-button>',
      hiddenLink: `<div hidden><a href="${reviewUrl}">Request a Review</a></div><kat-button label="More"></kat-button>`,
      late: '<div id="late"></div>',
    }[o.req || 'link'];
    return {
      html: `<h1>Order details</h1><div>Order ID: # ${id}</div><div>Purchase date: ${us(daysAgo(o.age))}</div>
        <div>Status: Shipped</div>${o.pageText || ''}
        <kat-button label="Refund order"></kat-button>${req}`,
      script: (w, env, tab) => {
        defineKat(w);
        const rr = w.document.getElementById('rr');
        if (rr && o.req === 'js') rr.addEventListener('click', () => w.__nav(reviewUrl));
        if (rr && o.req === 'newtab') rr.addEventListener('click', () => w.open(reviewUrl));
        if (rr && o.req === 'modal') {
          rr.addEventListener('click', () => {
            w.document.getElementById('modal').innerHTML = this.reviewPage(id).html;
            this.wireReview(w, env, id);
          });
        }
        if (o.req === 'late') {
          // The button and a refund badge render late, like a slow React page.
          setTimeout(() => {
            if (!w.document || !w.document.getElementById('late')) return; // page already gone
            w.document.getElementById('late').innerHTML = `${o.lateText || ''}<a href="${reviewUrl}"><kat-button label="Request a Review"></kat-button></a>`;
          }, 60);
        }
      },
    };
  }
  reviewPage(id) {
    const o = this.orders[id] || { amazon: 'blank' };
    const kind = o.amazon || 'eligible';
    const intro =
      "<h1>Request a Review</h1><p>We don't require you to request reviews because our systems already do that at no cost to you. However, if you prefer to request a review for this order, please use this feature instead of asking the customer via email or buyer-seller messaging.</p>";
    let html;
    if (kind === 'eligible' || kind === 'notEligible' || kind === 'already') {
      html = `${intro}<p>Are you sure you want to request a review for this order?</p><div id="yn"><kat-button id="yes" label="Yes"></kat-button><kat-button id="no" label="No"></kat-button></div>`;
    } else if (kind === 'eligibleSlow') {
      html = `${intro}<p>Orders outside the delivery window are not eligible.</p><div id="yn"></div>`;
    } else if (kind === 'alreadyNoYes') {
      html = `<h1>Request a Review</h1><kat-alert variant="warning" header="Not eligible at this time" description="You can't use this feature to request a review. You have already requested a review for this order."></kat-alert>`;
    } else if (kind === 'notEligibleNoYes') {
      html = `<h1>Request a Review</h1><kat-alert variant="warning" header="Not eligible at this time" description="You can't use this feature to request a review outside the 5-30 day range after the order delivery date."></kat-alert>`;
    } else {
      html = '<h1>Something went wrong</h1>';
    }
    return {
      html,
      script: (w, env) => {
        defineKat(w);
        this.wireReview(w, env, id);
      },
    };
  }
  wireReview(w, env, id) {
    const o = this.orders[id] || {};
    const hook = () => {
      const yes = w.document.getElementById('yes');
      if (!yes) return;
      yes.addEventListener('click', () => {
        env.yesClicks[id] = (env.yesClicks[id] || 0) + 1;
        const kind = o.amazon || 'eligible';
        if (kind === 'notEligible' || kind === 'already' || env.sends[id]) {
          const msg = kind === 'notEligible'
            ? '<kat-alert variant="warning" header="Not eligible at this time" description="You can\'t use this feature to request a review outside the 5-30 day range after the order delivery date."></kat-alert>'
            : '<p>You have already requested a review for this order.</p>';
          setTimeout(() => { if (w.document) w.document.body.innerHTML = msg; }, 40);
          return;
        }
        env.sends[id] = 1;
        const mode = o.result || 'spa';
        if (mode === 'spa') {
          setTimeout(() => {
            if (!w.document) return;
            w.document.body.innerHTML =
              '<kat-alert variant="success" description="A review will be requested for this order. (Note: We will suppress this request if a review has already been requested for this order)"></kat-alert>';
          }, 40);
        } else if (mode === 'page') {
          w.__nav('/messaging/reviews/done');
        } // 'none': nothing visible happens
      });
    };
    if (o.amazon === 'eligibleSlow') {
      setTimeout(() => {
        w.document.getElementById('yn').innerHTML = '<kat-button id="yes" label="Yes"></kat-button><kat-button id="no" label="No"></kat-button>';
        hook();
      }, 60);
    } else hook();
    if (env.onReviewPage) env.onReviewPage(id, w);
  }
}

function defineKat(w) {
  if (w.customElements.get('kat-button')) return;
  w.customElements.define(
    'kat-button',
    class extends w.HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const s = this.attachShadow({ mode: 'open' });
        const b = w.document.createElement('button');
        b.textContent = this.getAttribute('label');
        if (this.hasAttribute('disabled')) b.disabled = true;
        s.appendChild(b);
      }
    }
  );
}

// ---------------- fake Safari ----------------
class Env {
  constructor(site, { store } = {}) {
    this.site = site;
    this.store = store || {};
    this.tabs = new Map();
    this.nextId = 1;
    this.listeners = new Set();
    this.sends = {};
    this.yesClicks = {};
    this.visits = {}; // orderId -> order-page loads
    this.errors = [];
    this.startBackground();
  }
  storageApi(owner) {
    const env = this;
    const dead = () => owner && owner.closed;
    const never = () => new Promise(() => {});
    return {
      local: {
        async get(keys) {
          if (dead()) return never();
          await tick();
          const ks = keys == null ? Object.keys(env.store) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of ks) if (k in env.store) out[k] = clone(env.store[k]);
          return out;
        },
        async set(obj) {
          if (dead()) return never();
          await tick();
          const ch = {};
          for (const [k, v] of Object.entries(obj)) {
            ch[k] = { oldValue: clone(env.store[k]), newValue: clone(v) };
            env.store[k] = clone(v);
          }
          env.emit(ch);
        },
        async remove(keys) {
          if (dead()) return never();
          await tick();
          const ch = {};
          for (const k of typeof keys === 'string' ? [keys] : keys) {
            if (k in env.store) {
              ch[k] = { oldValue: env.store[k] };
              delete env.store[k];
            }
          }
          if (Object.keys(ch).length) env.emit(ch);
        },
      },
      onChanged: {
        addListener: (fn) => env.listeners.add({ fn, owner }),
        removeListener: (fn) => {
          for (const l of env.listeners) if (l.fn === fn) env.listeners.delete(l);
        },
      },
    };
  }
  emit(ch) {
    for (const l of [...this.listeners]) {
      if (l.owner && l.owner.closed) {
        this.listeners.delete(l);
        continue;
      }
      setTimeout(() => l.fn(clone(ch), 'local'), 0);
    }
  }
  startBackground() {
    this.bgMsg = [];
    this.bgRemoved = [];
    const env = this;
    const api = {
      runtime: { onMessage: { addListener: (fn) => env.bgMsg.push(fn) } },
      tabs: {
        create: async ({ url, active }) => {
          env.createdActive = (env.createdActive || []).concat(!!active);
          env.bgTabs = (env.bgTabs || 0) + 1;
          return env.createTab(url);
        },
        update: async (id, props) => {
          env.activated = (env.activated || []).concat(id);
          return { id };
        },
        remove: async (id) => env.removeTab(id),
        onRemoved: { addListener: (fn) => env.bgRemoved.push(fn) },
      },
      storage: this.storageApi(null),
      action: { onClicked: { addListener() {} } },
    };
    vm.runInContext(BG, vm.createContext({ browser: api, console, setTimeout, clearTimeout, URL }));
  }
  async toBackground(msg, tab, owner) {
    if (owner.closed) return new Promise(() => {}); // an unloading page can't talk
    await tick();
    const sender = { tab: { id: tab.id, url: tab.url }, url: tab.url };
    // Chrome's rules (the strictest): only sendResponse counts, and only when
    // the listener returns true. A returned Promise is ignored.
    for (const fn of this.bgMsg) {
      let respond;
      const answered = new Promise((r) => (respond = r));
      const r = fn(clone(msg), sender, (v) => respond(v));
      if (r === true) return clone(await answered);
    }
    throw new Error('Receiving end does not exist.');
  }
  createTab(url) {
    const id = this.nextId++;
    const tab = { id, url: null, win: null, owner: null, closed: false };
    this.tabs.set(id, tab);
    setTimeout(() => this.load(tab, url), 8);
    return { id };
  }
  removeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No tab with id ${id}`);
    this.tabs.delete(id);
    this.unload(tab);
    tab.closed = true;
    for (const fn of this.bgRemoved) fn(id, {});
  }
  unload(tab) {
    if (!tab.win) return;
    tab.owner.closed = true;
    const w = tab.win;
    tab.win = null;
    try {
      w.close();
    } catch (e) {
      /* ignore */
    }
  }
  load(tab, url) {
    if (tab.closed) return;
    this.unload(tab);
    tab.url = url;
    const m = url.match(/\/orders-v3\/order\/(\d{3}-\d{7}-\d{7})/);
    if (m) this.visits[m[1]] = (this.visits[m[1]] || 0) + 1;
    const page = this.site.render(url);
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => this.errors.push(`jsdom: ${e.message}`));
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${page.html}</body></html>`, {
      url,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
    const w = dom.window;
    w.Element.prototype.getClientRects = function () {
      return this.closest('[hidden]') ? [] : [1];
    };
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
    });
    const owner = { closed: false };
    tab.owner = owner;
    tab.win = w;
    w.confirm = () => this.confirmAnswer !== false;
    w.__nav = (u) => {
      owner.closed = true; // this page is going away now
      const next = new URL(u, url).href;
      setTimeout(() => this.load(tab, next), 8);
    };
    w.open = (u) => {
      this.createTab(new URL(u, url).href);
      return null;
    };
    w.browser = { runtime: { sendMessage: (msg) => this.toBackground(msg, tab, owner) }, storage: this.storageApi(owner) };
    w.__nudgeFrameLoader = (frame, u) => this.frameLoad(frame, u, tab);
    w.fetch = (u, opts) => this.api(new URL(u, url).href, opts || {});
    if (page.script) page.script(w, this, tab);
    if (url.startsWith('https://sellercentral.amazon.com/')) {
      w.eval(WORKER);
      w.eval(ORDERS);
    }
  }
  // Amazon's internal endpoint behind the Yes button.
  async api(url, opts) {
    await sleep(5);
    const m = url.match(/\/messaging\/api\/solicitations\/(\d{3}-\d{7}-\d{7})\/productReviewAndSellerFeedback\?marketplaceId=([A-Z0-9]+)/);
    const json = (status, body) => ({ type: 'basic', status, json: async () => body });
    if (m && opts.method === 'GET') {
      // Read-only lookup. site.getMode: 'none' (no JSON, like an unknown endpoint) or 'json'.
      this.gets = this.gets || {};
      this.gets[m[1]] = (this.gets[m[1]] || 0) + 1;
      const o = this.site.orders[m[1]] || {};
      if (this.site.getMode !== 'json') return { type: 'basic', status: 404, json: async () => { throw new Error('html'); } };
      const kind = o.amazon || 'eligible';
      if (this.sends[m[1]] || kind === 'already' || kind === 'alreadyNoYes') return json(200, { isSuccess: false, ineligibleReason: 'REVIEW_REQUEST_ALREADY_SENT' });
      if (kind === 'eligible' || kind === 'eligibleSlow') return json(200, { isSuccess: true });
      return json(200, { isSuccess: false, ineligibleReason: 'REVIEW_REQUEST_OUTSIDE_TIME_WINDOW' });
    }
    if (!m || opts.method !== 'POST') return { type: 'basic', status: 404, json: async () => { throw new Error('html'); } };
    const id = m[1];
    this.posts = this.posts || {};
    this.posts[id] = (this.posts[id] || 0) + 1;
    this.lastMarketplace = m[2];
    const o = this.site.orders[id] || {};
    if (o.apiDelay) await sleep(o.apiDelay);
    if (o.api === '403' || this.site.apiDown) return { type: 'basic', status: 403, json: async () => { throw new Error('html'); } };
    if (o.api === 'redirect') return { type: 'opaqueredirect', status: 0, json: async () => { throw new Error('none'); } };
    if (o.api === 'throw') throw new TypeError('Load failed');
    const kind = o.amazon || 'eligible';
    if (o.reason) return json(200, { isSuccess: false, ineligibleReason: o.reason });
    if (this.sends[id] || kind === 'already' || kind === 'alreadyNoYes') return json(200, { isSuccess: false, ineligibleReason: 'REVIEW_REQUEST_ALREADY_SENT' });
    if (kind === 'notEligible' || kind === 'notEligibleNoYes') return json(200, { isSuccess: false, ineligibleReason: 'REVIEW_REQUEST_OUTSIDE_TIME_WINDOW' });
    if (kind === 'blank') return { type: 'basic', status: 500, json: async () => { throw new Error('html'); } };
    this.sends[id] = 1;
    return json(200, { isSuccess: true });
  }
  // Invisible frame: serve the fake site into a jsdom iframe (same origin).
  async frameLoad(frame, url, tab) {
    await sleep(8);
    if (this.site.frameBlocked) return 'blocked';
    this.fillFrame(frame, url);
    return 'continue';
  }
  fillFrame(frame, url) {
    const fw = frame.contentWindow;
    const fd = frame.contentDocument;
    if (!fw || !fd) return;
    if (!fw.__stubbed) {
      fw.__stubbed = true;
      fw.Element.prototype.getClientRects = function () {
        return this.closest('[hidden]') ? [] : [1];
      };
      Object.defineProperty(fw.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
      fw.open = () => null; // sandbox: no popups
    }
    const m = url.match(/\/orders-v3\/order\/(\d{3}-\d{7}-\d{7})/);
    if (m) this.visits[m[1]] = (this.visits[m[1]] || 0) + 1;
    if (m && this.onOrderPage) this.onOrderPage(m[1]);
    this.frameLoads = (this.frameLoads || 0) + 1;
    let page = this.site.render(url);
    if (this.site.frameBrokenReview && /\/messaging\/reviews/.test(url)) page = { html: '<h1>Something went wrong</h1>' };
    fd.body.innerHTML = page.html;
    fw.__nav = (u) => setTimeout(() => this.fillFrame(frame, new URL(u, url).href), 8);
    if (page.script) page.script(fw, this, { id: 'frame' });
  }
  openList() {
    const { id } = this.createTab('https://sellercentral.amazon.com/orders-v3/mfn/shipped');
    return id;
  }
  win(id) {
    return this.tabs.get(id).win;
  }
}

// ---------------- test helpers ----------------
async function waitFor(cond, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await cond();
    if (v) return v;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}
function deepQuery(w, sel) {
  const stack = [w.document];
  const out = [];
  while (stack.length) {
    const r = stack.pop();
    out.push(...r.querySelectorAll(sel));
    for (const e of r.querySelectorAll('*')) if (e.shadowRoot) stack.push(e.shadowRoot);
  }
  return out;
}
const btnOf = (w, id) => deepQuery(w, `[data-nudge-id="${id}"]`)[0] || null;
const label = (w, id) => ((btnOf(w, id) || {}).textContent || '').replace(/\u00a0/g, ' ');
const countPills = (w) => deepQuery(w, '[data-nudge-id]').length;
const launcherOf = (w) => w.document.getElementById('nudge-launcher');
const launcherText = (w) => (launcherOf(w) ? launcherOf(w).querySelector('[data-label]').textContent : '');
const idle = (w) => launcherText(w) === 'Request Reviews';
const statusText = (w) => ((launcherOf(w) && launcherOf(w).dataset.status) || '').replace(/\u00a0/g, ' ');
async function ready(env, tabId, n) {
  await waitFor(() => env.win(tabId) && env.win(tabId).document.body, 3000, 'page');
  const w = env.win(tabId);
  if (n) await waitFor(() => countPills(w) >= n && launcherOf(w), 3000, `${n} pills`);
  return w;
}
async function sendAll(w) {
  launcherOf(w).click();
  await waitFor(() => !idle(w), 2000, 'batch start').catch(() => {});
  return waitFor(() => idle(w) && statusText(w), 30000, 'batch end');
}
async function stopBackground() {}
async function tap(env, w, id) {
  const before = env.store.statuses && env.store.statuses[id] ? env.store.statuses[id].checkedAt : 0;
  btnOf(w, id).click();
  await waitFor(
    () => env.store.statuses && env.store.statuses[id] && env.store.statuses[id].checkedAt > before && !env.store.currentJob && idle(w) && label(w, id) !== 'Sending…',
    15000,
    `result for ${id}`
  );
  await sleep(60);
}
const st = (env, id) => (env.store.statuses || {})[id] || {};
const openTabs = (env) => [...env.tabs.keys()];
const popOf = (w) => w.document.getElementById('nudge-pop');
const popVisible = (w) => popOf(w) && !popOf(w).hidden;
const popTitle = (w) => (popVisible(w) ? popOf(w).querySelector('.nudge-pop-title').textContent : '');
const toastOf = (w) => w.document.getElementById('nudge-toast');
const toastLines = (w) => (toastOf(w) && !toastOf(w).hidden ? [...toastOf(w).querySelectorAll('.nudge-toast-line')].map((l) => l.textContent.replace(/\u00a0/g, ' ')) : []);
const toastText = (w) => toastLines(w).join(' ');
const frames = (w) => w.document.querySelectorAll('iframe[data-nudge-ui]').length;

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}
const id = (n) => `111-0000000-${String(n).padStart(7, '0')}`;
const S4 = (extra = {}) => ({ settings: { v: 5, method: 'fast', ...extra } });
const shortD = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

async function main() {
  // B1: one tap, quick send
  {
    const env = new Env(new Site({ [id(1)]: { age: 12, amazon: 'eligible' }, [id(2)]: { age: 3, amazon: 'eligible' } }), { store: S4() });
    const tab = env.openList();
    const w = await ready(env, tab, 2);
    check('B1 one "Request Reviews" button right after Refresh (no menu)', launcherOf(w).previousElementSibling.id === 'refresh' && !w.document.getElementById('nudge-more') && !w.document.getElementById('nudge-panel'));
    check('B1 order 3 days old shows when it opens (deliver-by + 5 days)', label(w, id(2)) === `Opens ~${shortD(6)}`, label(w, id(2)));
    const line = btnOf(w, id(1)).parentElement;
    check('B1 pill on its own line under the order number', line.hasAttribute('data-nudge-ui') && line.previousElementSibling.tagName === 'A');
    const t0 = Date.now();
    await tap(env, w, id(1));
    const took = Date.now() - t0;
    check('B1 one tap sends via quick send (1 request, no Yes page)', st(env, id(1)).status === 'sent' && env.posts[id(1)] === 1 && !env.yesClicks[id(1)], JSON.stringify(st(env, id(1))));
    check('B1 no order page opened (returns come from Manage Returns); no tabs or frames left', !env.visits[id(1)] && frames(w) === 0 && !env.bgTabs && openTabs(env).length === 1);
    check('B1 correct marketplace (Amazon.com)', env.lastMarketplace === 'ATVPDKIKX0DER');
    check('B1 green "Sent ✓" + notice', label(w, id(1)) === 'Sent ✓' && toastText(w) === 'Review requested ✓', `${label(w, id(1))} / ${toastText(w)}`);
    check('B1 fast (well under a second in simulation)', took < 1500, `${took}ms`);
    btnOf(w, id(1)).click();
    await sleep(60);
    check('B1 tapping a sent order only explains it', popTitle(w) === '✓ Review requested' && env.posts[id(1)] === 1);
  }

  // B2: old settings (return check off, other methods) are ignored: the check always runs
  {
    const env = new Env(new Site({ [id(3)]: { age: 12, amazon: 'eligible' } }), { store: { settings: { v: 4, checkReturns: false, method: 'visibleTab' } } });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(3));
    check('B2 old settings ignored; quick send used', st(env, id(3)).status === 'sent' && env.posts[id(3)] === 1 && !env.bgTabs);
  }

  // B3: refund shown in the orders list itself → marked immediately, can't be sent
  {
    const env = new Env(new Site({ [id(4)]: { age: 12, amazon: 'eligible', rowText: '<span class="badge">Refunded</span>' }, [id(5)]: { age: 12, amazon: 'eligible' } }), { store: S4() });
    const w = await ready(env, env.openList(), 2);
    await waitFor(() => label(w, id(4)) === '↩ Refunded · skipped', 3000, 'refund pill').catch(() => {});
    check('B3 "Refunded" in the list → "↩ Refunded · skipped" before any tap', label(w, id(4)) === '↩ Refunded · skipped' && /dashed/.test(btnOf(w, id(4)).style.border), `${label(w, id(4))} ${btnOf(w, id(4)).style.border}`);
    check('B3 product link text "returned to us" is ignored', label(w, id(5)) === 'Request review');
    btnOf(w, id(4)).click();
    await sleep(80);
    check('B3 tapping it only explains; nothing sent', popTitle(w) === 'Refunded – skipped' && !(env.posts || {})[id(4)], popTitle(w));
  }

  // B4: return found on the order page → Returned · skipped
  {
    const site4 = new Site({ [id(6)]: { age: 12, amazon: 'eligible' } });
    site4.returns = [id(6)];
    const env = new Env(site4, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(6));
    check('B4 on Manage Returns → "↩ Returned · skipped", nothing sent', label(w, id(6)) === '↩ Returned · skipped' && !(env.posts || {})[id(6)] && popTitle(w) === 'Returned – skipped', `${label(w, id(6))} / ${popTitle(w)}`);
  }

  // B5: v0.3's wrongly-closed orders are repaired; "not eligible" → "Request review" the next day
  {
    const y = localDay(daysAgo(1));
    const store = S4();
    store.statuses = {
      [id(7)]: { status: 'closed', detail: "It was eligible on 2026-09-26; Amazon now says it isn't, so its window has passed.", checkedDay: localDay(), checkedAt: Date.now(), seenEligible: true },
      [id(8)]: { status: 'eligible', checkedDay: localDay(), checkedAt: Date.now() },
    };
    const env = new Env(new Site({ [id(7)]: { age: 12, amazon: 'notEligible' }, [id(8)]: { age: 12, amazon: 'eligible' } }), { store });
    const w = await ready(env, env.openList(), 2);
    await waitFor(() => label(w, id(7)) === 'Request review', 2000, 'repair').catch(() => {});
    check('B5 wrongly "Window closed" order is reopened ("Request review")', label(w, id(7)) === 'Request review' && label(w, id(8)) === 'Request review', `${label(w, id(7))} / ${label(w, id(8))}`);
    await tap(env, w, id(7));
    check('B5 Amazon still says no → "Not eligible yet" (not closed) + popup', st(env, id(7)).status === 'notEligible' && label(w, id(7)) === 'Not eligible yet' && popTitle(w) === 'Not eligible yet', label(w, id(7)));
    env.store.statuses[id(7)].checkedDay = y;
    env.site.orders[id(7)].amazon = 'eligible';
    const w2 = await ready(env, env.openList(), 2);
    check('B5 next day it says "Request review"', label(w2, id(7)) === 'Request review', label(w2, id(7)));
    await tap(env, w2, id(7));
    check('B5 and sends once Amazon allows it', st(env, id(7)).status === 'sent');
  }

  // B6: one click on "Request Reviews" sends the whole page, no daily limit
  {
    const orders = {
      [id(11)]: { age: 12, amazon: 'eligible' },
      [id(12)]: { age: 12, amazon: 'eligible', rowText: '<span>Refund applied</span>' },
      [id(13)]: { age: 12, amazon: 'eligible', pageText: '<div>Refunds</div><div>No refunds issued</div>' },
      [id(14)]: { age: 8, amazon: 'notEligible' },
      [id(15)]: { age: 2, amazon: 'eligible' },
      [id(16)]: { age: 70, amazon: 'eligible' },
      [id(17)]: { age: 20, amazon: 'already' },
      [id(18)]: { age: 15, amazon: 'eligible', pageText: '<kat-badge label="Refunded"></kat-badge>' },
      [id(19)]: { age: 15, req: 'late', lateText: '<div>Refund issued: $12.00</div>', amazon: 'eligible' },
      [id(20)]: { age: 15, amazon: 'eligible', channel: 'Amazon.ca' },
    };
    for (let n = 21; n <= 80; n++) orders[id(n)] = { age: 10 + (n % 20), amazon: 'eligible' };
    const site6 = new Site(orders);
    site6.returns = [id(18), id(19)];
    const env = new Env(site6, { store: S4() });
    const w = await ready(env, env.openList(), 70);
    const end = await sendAll(w);
    const S = (n) => st(env, id(n)).status;
    const sent = Object.keys(env.sends).length;
    check('B6 no confirmation, finished with a summary', /^Done\. Sent 63/.test(end), end);
    check('B6 no daily limit: all 63 eligible orders sent, once each', sent === 63 && Object.values(env.posts).every((c) => c === 1), `sent ${sent}`);
    check('B6 refunds/returns skipped (list label, badge, late text)', S(12) === 'skippedReturn' && S(18) === 'skippedReturn' && S(19) === 'skippedReturn' && !env.posts[id(12)] && !env.posts[id(18)] && !env.posts[id(19)]);
    check('B6 "No refunds issued" is not a refund', S(13) === 'sent');
    check('B6 delivered 4 days ago → not tried yet ("Opens ~tomorrow")', !S(14) && !env.posts[id(14)] && label(w, id(14)) === `Opens ~${shortD(1)}` && S(17) === 'already', label(w, id(14)));
    check('B6 too early / too old never touched', !S(15) && !S(16) && !env.posts[id(15)] && !env.posts[id(16)]);
    check('B6 summary names the next batch day', new RegExp(`already requested\\. Next batch: ${shortD(1)} \\(1 order\\)`).test(end), end);
    check('B6 Amazon.ca order used the Canada marketplace', st(env, id(20)).status === 'sent');
    check('B6 no tabs, no leftover frames', !env.bgTabs && frames(w) === 0 && openTabs(env).length === 1);
    check('B6 each sentence on its own line; dates never split', toastLines(w).length === 3 && toastLines(w)[0] === 'Done.' && /^Next batch: /.test(toastLines(w)[2]) && /Sep\u00a0|Oct\u00a0|[A-Z][a-z]{2}\u00a0\d/.test(toastOf(w).textContent), JSON.stringify(toastLines(w)));
    check('B6 summary notice', /^Done\. Sent 63 · 2 returns\/refunds skipped · 1 already requested\. Next batch:/.test(toastText(w)), toastText(w));
  }

  // B7: quick send rejected → falls back to Amazon's page (Yes) → sent; switches after 2
  {
    const orders = { [id(31)]: { age: 12, amazon: 'eligible', api: '403' }, [id(32)]: { age: 12, amazon: 'eligible', api: '403' }, [id(33)]: { age: 12, amazon: 'eligible' } };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 3);
    await tap(env, w, id(31));
    check('B7 rejected quick send → sent through Amazon\'s page instead', st(env, id(31)).status === 'sent' && env.yesClicks[id(31)] === 1 && env.posts[id(31)] === 1, JSON.stringify(st(env, id(31))));
    await tap(env, w, id(32));
    check('B7 after 2 rejections it switches to Amazon\'s page for good', env.store.settings.method === 'page' && st(env, id(32)).status === 'sent');
    await tap(env, w, id(33));
    check('B7 next order goes straight through the page (no quick request)', st(env, id(33)).status === 'sent' && !env.posts[id(33)] && env.yesClicks[id(33)] === 1);
  }

  // B8: Amazon refuses invisible pages → tab for those orders; remembered
  {
    const site = new Site({ [id(41)]: { age: 12, amazon: 'eligible' }, [id(42)]: { age: 12, amazon: 'eligible' } });
    site.frameBlocked = true;
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    await tap(env, w, id(41));
    check('B8 invisible pages blocked → returns list unreadable, still sent (best effort)', st(env, id(41)).status === 'sent', toastText(w));
  }

  // B9: CAPTCHA while checking an order → stops, explains
  {
    const orders = { [id(51)]: { age: 12, amazon: 'eligible' }, [id(52)]: { age: 12, amazon: 'eligible' } };
    const site9 = new Site(orders);
    site9.returnsLayout = 'captcha';
    const env = new Env(site9, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    const end = await sendAll(w);
    check('B9 CAPTCHA on the returns page → stops before sending anything, says why', /^Stopped\. Amazon showed a CAPTCHA while reading Manage Returns/.test(end) && !env.posts, end);
    check('B9 notice explains, red dot on the button', /CAPTCHA/.test(toastText(w)) && launcherOf(w).querySelector('[data-dot]').style.display === 'inline-block', toastText(w));
  }

  // B10: clicking the running button stops it
  {
    const orders = {};
    for (let n = 61; n <= 70; n++) orders[id(n)] = { age: 12, amazon: 'eligible' };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 10);
    launcherOf(w).click();
    await waitFor(() => /Sending 1 of 10 · Stop/.test(launcherText(w)), 3000, 'running');
    launcherOf(w).click();
    const end = await waitFor(() => idle(w) && statusText(w), 10000, 'stopped');
    check('B10 "Sending 1 of 10 · Stop" → stops after the current order', /^Stopped\./.test(end) && Object.keys(env.sends).length <= 2, `${end} sends=${Object.keys(env.sends).length}`);
  }

  // B11: background restarts mid-order
  {
    const env = new Env(new Site({ [id(71)]: { age: 12, amazon: 'eligible' } }), { store: S4({ method: 'page', switchedDay: localDay() }) });
    let restarted = false;
    env.onOrderPage = () => {
      if (!restarted) {
        restarted = true;
        env.startBackground();
      }
    };
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(71));
    check('B11 survives a background restart', restarted && st(env, id(71)).status === 'sent' && env.yesClicks[id(71)] === 1);
  }

  // B12: new layout (shadow DOM cards, no toolbar)
  {
    const env = new Env(new Site({ [id(81)]: { age: 12, amazon: 'eligible' }, [id(82)]: { age: 1, amazon: 'eligible' } }, 'cards'), { store: S4() });
    const w = await ready(env, env.openList(), 2);
    check('B12 floating button when there is no toolbar', launcherOf(w).classList.contains('nudge-floating'));
    await tap(env, w, id(81));
    check('B12 pills in shadow DOM work; card not opened', st(env, id(81)).status === 'sent' && !env.cardClicks && /^Opens ~/.test(label(w, id(82))), label(w, id(82)));
  }

  // B13: two tabs can't send at the same time
  {
    const env = new Env(new Site({ [id(91)]: { age: 12, amazon: 'eligible', apiDelay: 800 }, [id(92)]: { age: 12, amazon: 'eligible' } }), { store: S4() });
    const w1 = await ready(env, env.openList(), 2);
    const w2 = await ready(env, env.openList(), 2);
    btnOf(w1, id(91)).click();
    await waitFor(() => env.store.currentJob, 3000, 'job 1');
    btnOf(w2, id(92)).click();
    await waitFor(() => /Another order is still being processed/.test(toastText(w2)), 3000, 'busy');
    await waitFor(() => !env.store.currentJob && st(env, id(91)).status === 'sent', 10000, 'job 1');
    check('B13 second tab refused while the first is sending', !(env.posts || {})[id(92)]);
  }

  // B14: order page you open yourself: no extension UI
  {
    const env = new Env(new Site({ [id(95)]: { age: 12, amazon: 'eligible' } }), { store: S4() });
    const { id: t } = env.createTab(`https://sellercentral.amazon.com/orders-v3/order/${id(95)}`);
    await sleep(400);
    const w = env.win(t);
    check('B14 no pills or button on an order page', countPills(w) === 0 && !launcherOf(w));
  }

  // B15: two errors in a row stop the run
  {
    const orders = { [id(101)]: { age: 12, amazon: 'blank' }, [id(102)]: { age: 12, amazon: 'blank' }, [id(103)]: { age: 12, amazon: 'eligible' } };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 3);
    const end = await sendAll(w);
    check('B15 stops after 2 errors in a row', /2 errors in a row/.test(end) && !(env.posts || {})[id(103)], end);
    check('B15 red "Error – tap" pills', label(w, id(101)) === 'Error – tap' && label(w, id(102)) === 'Error – tap');
  }

  // B16: Amazon shows Yes even when not eligible (page method) → "Not eligible yet", not closed
  {
    const env = new Env(new Site({ [id(111)]: { age: 12, amazon: 'notEligible' } }), { store: S4({ method: 'page', switchedDay: localDay() }) });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(111));
    check('B16 Yes then "not eligible" → Not eligible yet (retry tomorrow)', st(env, id(111)).status === 'notEligible' && env.yesClicks[id(111)] === 1);
  }

  // B17: error pill → "Request review" in the popup
  {
    const orders = { [id(121)]: { age: 12, amazon: 'blank' } };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(121));
    check('B17 error popup opens automatically', popTitle(w) === "Didn't go through" && /Tap to see why/.test(toastText(w)));
    orders[id(121)].amazon = 'eligible';
    popOf(w).querySelector('.nudge-pop-action').click();
    await waitFor(() => st(env, id(121)).status === 'sent' && idle(w), 10000, 'retry');
    check('B17 "Request review" in the popup sends it', label(w, id(121)) === 'Sent ✓');
  }

  // B18: nothing to send → says so, and what's coming up
  {
    const orders = { [id(131)]: { age: 3, amazon: 'eligible' }, [id(132)]: { age: 4, amazon: 'eligible' }, [id(133)]: { age: 1, amazon: 'eligible' }, [id(134)]: { age: 60, amazon: 'eligible' } };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 4);
    launcherOf(w).click();
    await waitFor(() => toastText(w), 3000, 'notice');
    check('B18 nothing eligible → "Nothing to send" + next batch day', new RegExp(`^Nothing to send right now\\. Next batch: ${shortD(5)} \\(1 order\\), then ${shortD(6)} \\(1 order\\)`).test(toastText(w)), toastText(w));
    check('B18 nothing was sent or opened', !env.posts && !Object.keys(env.visits).length);
  }

  // B19: a check-only job can never reach "sent" (background guard)
  {
    const env = new Env(new Site({ [id(141)]: { age: 12, req: 'none' } }));
    const fakeTab = { id: 999, url: 'x' };
    const res = await env.toBackground({ type: 'runJob', job: { orderId: id(141), url: `https://sellercentral.amazon.com/orders-v3/order/${id(141)}`, dryRun: true, mode: 'tab' } }, { id: 0, url: '' }, { closed: false });
    await waitFor(() => env.store.currentJob && env.store.currentJob.activeTabId, 2000, 'job');
    const t = { id: env.store.currentJob.activeTabId, url: '' };
    const s1 = await env.toBackground({ type: 'stage', stage: 'confirmPage' }, t, { closed: false });
    const s2 = await env.toBackground({ type: 'stage', stage: 'clickedYes' }, t, { closed: false });
    check('B19 background refuses to let a check-only job send', res.ok && s1 === true && s2 === false);
    await env.toBackground({ type: 'abortJob', orderId: id(141) }, fakeTab, { closed: false });
  }

  // R1: an order with a pending return on Manage Returns (new layout) is skipped
  {
    const site = new Site({ [id(301)]: { age: 12, amazon: 'eligible' }, [id(302)]: { age: 14, amazon: 'eligible' }, [id(303)]: { age: 12, amazon: 'eligible' } });
    site.returns = [id(302), '111-9999999-0000001', id(302)];
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 3);
    const end = await sendAll(w);
    check('R1 pending return (not shown on orders page) → skipped, never sent', st(env, id(302)).status === 'skippedReturn' && !env.posts[id(302)] && label(w, id(302)) === '↩ Returned · skipped', label(w, id(302)));
    check('R1 others sent; summary counts the skip', st(env, id(301)).status === 'sent' && st(env, id(303)).status === 'sent' && /Sent 2 · 1 return\/refund skipped/.test(end), end);
    check('R1 no leftover frames', frames(w) === 0);
  }

  // R2: new layout unreadable → classic, 23 returns across pages
  {
    const orders = { [id(311)]: { age: 12, amazon: 'eligible' }, [id(312)]: { age: 12, amazon: 'eligible' } };
    const many = [];
    for (let n = 0; n < 22; n++) many.push(`112-5555555-${String(n).padStart(7, '0')}`);
    const site = new Site(orders);
    site.returnsLayout = 'newBroken';
    site.returns = [...many, id(312)]; // the order to skip is on the last page
    site.classicSizes = false;
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    await sendAll(w);
    check('R2 classic fallback, clicks Next through every page, finds the return on page 3', env.returnPages === 2 && st(env, id(312)).status === 'skippedReturn' && !env.posts[id(312)] && st(env, id(311)).status === 'sent', `pages=${env.returnPages} ${st(env, id(312)).status}`);

    // with the per-page menu: switches to 50 and needs no Next
    const site2 = new Site({ [id(313)]: { age: 12, amazon: 'eligible' } });
    site2.returnsLayout = 'newBroken';
    site2.returns = [...many, id(313)];
    const env2 = new Env(site2, { store: S4() });
    const w2 = await ready(env2, env2.openList(), 1);
    await sendAll(w2);
    check('R2 picks 50 per page instead of paging', env2.sizeChanged === 50 && !env2.returnPages && st(env2, id(313)).status === 'skippedReturn' && !env2.posts);
  }

  // R5: a sign-in page while reading returns stops the run
  {
    const site = new Site({ [id(341)]: { age: 12, amazon: 'eligible' } });
    site.returnsLayout = 'login';
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    const end = await sendAll(w);
    check('R5 sign-in page on Manage Returns → stopped, nothing sent', /^Stopped\. Amazon asked you to sign in/.test(end) && !env.posts, end);
  }

  // R4: Seller Central's own "Manage Returns" menu link is used first
  {
    const site = new Site({ [id(331)]: { age: 12, amazon: 'eligible' }, [id(332)]: { age: 12, amazon: 'eligible' } });
    site.returns = [id(332)];
    site.returnsLayout = 'newBroken'; // the built-in addresses would fail…
    site.menuReturns = true; // …but the menu link works
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    await sendAll(w);
    check('R4 menu link to Manage Returns used; return skipped', site.menuHit && st(env, id(332)).status === 'skippedReturn' && st(env, id(331)).status === 'sent');
  }

  // F1–F3: FBA returns (their own page, one click from Manage Returns)
  for (const via of ['link', 'menu']) {
    const site = new Site({ [id(351)]: { age: 12, amazon: 'eligible' }, [id(352)]: { age: 14, amazon: 'eligible' } });
    site.fbaVia = via;
    site.fbaReturns = [{ id: id(352), days: 45 }]; // only shows with the 90-day filter
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    const end = await sendAll(w);
    check(`F ${via}: FBA return found (widest date range) and skipped; others sent`, env.fbaWide && st(env, id(352)).status === 'skippedReturn' && !(env.posts || {})[id(352)] && st(env, id(351)).status === 'sent' && !/couldn't be read/.test(end), end);
  }
  {
    // Return authorized but not refunded yet: found when the page can filter by authorized date.
    const site = new Site({ [id(356)]: { age: 12, amazon: 'eligible' }, [id(357)]: { age: 12, amazon: 'eligible' } });
    site.fbaVia = 'link';
    site.fbaAuthFilter = true;
    site.fbaReturns = [{ id: id(357), days: 3, refunded: false }];
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 2);
    await sendAll(w);
    check('F authorized-date filter used when offered → unrefunded FBA return skipped', env.fbaAuth && st(env, id(357)).status === 'skippedReturn' && st(env, id(356)).status === 'sent');
  }
  {
    const site = new Site({ [id(355)]: { age: 12, amazon: 'eligible' } });
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    const end = await sendAll(w);
    check('F no FBA returns page on the account → nothing extra, no warning', st(env, id(355)).status === 'sent' && /^Done\. Sent 1\.$/.test(end), end);
  }

  // R3: list can't be fully read → nothing sent at all
  {
    const many = [];
    for (let n = 0; n < 15; n++) many.push(`112-6666666-${String(n).padStart(7, '0')}`);
    const site = new Site({ [id(321)]: { age: 12, amazon: 'eligible' } });
    site.returnsLayout = 'newBroken';
    site.returns = many;
    site.classicSizes = false;
    site.classicNext = false;
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    const end3 = await sendAll(w);
    check('R3 list only partly readable → not trusted; sends, notes it', st(env, id(321)).status === 'sent' && /Manage Returns couldn't be read/.test(end3), end3);

    const site2 = new Site({ [id(322)]: { age: 12, amazon: 'eligible', rowText: '<span class="badge">Refunded</span>' }, [id(323)]: { age: 12, amazon: 'eligible' } });
    site2.returnsLayout = 'down';
    const env2 = new Env(site2, { store: S4() });
    const w2 = await ready(env2, env2.openList(), 2);
    await sendAll(w2);
    check('R3 without Manage Returns, orders-page "Refunded" is still skipped', st(env2, id(322)).status === 'skippedReturn' && !(env2.posts || {})[id(322)] && st(env2, id(323)).status === 'sent');
  }

  // P1: pages through Amazon's list until a page reaches orders past 30 days
  {
    const ages = [2, 3, 9, 10, 10, 11, 12, 13, 20, 25, 28, 33, 40, 50, 60, 70, 80, 90];
    const orders = {};
    ages.forEach((a, k) => (orders[id(400 + k)] = { age: a, amazon: 'eligible' }));
    const site = new Site(orders);
    site.pageSize = 5;
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 5);
    const end = await sendAll(w);
    const want = ages.filter((a) => a >= 9 && a <= 34).length;
    check('P1 continues to page 2 and 3, stops after the page with a 40-day-old order', env.listPages === 2 && Object.keys(env.sends).length === want, `pages=${env.listPages} sent=${Object.keys(env.sends).length}/${want}`);
    check('P1 summary covers every page and the next batch from page 1', new RegExp(`^Done\\. Sent ${want} across 3 pages\\. Next batch: `).test(end), end);
  }

  // P2: first page has nothing ready yet → still checks the next page
  {
    const orders = {};
    [1, 2, 2, 3, 12, 14].forEach((a, k) => (orders[id(430 + k)] = { age: a, amazon: 'eligible' }));
    const site = new Site(orders);
    site.pageSize = 4;
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 4);
    const end = await sendAll(w);
    check('P2 empty first page → page 2 orders still sent, then stops at the last page', env.listPages === 1 && Object.keys(env.sends).length === 2, end);
  }

  // D1: old results are dropped a day after their window closes
  {
    const store = S4();
    store.statuses = {
      [id(450)]: { status: 'sent', closesOn: localDay(daysAgo(2)), checkedAt: Date.now() - 40 * 86400000, checkedDay: 'x' },
      [id(451)]: { status: 'sent', orderDate: localDay(daysAgo(50)), checkedAt: Date.now(), checkedDay: 'x' },
      [id(452)]: { status: 'sent', closesOn: localDay(), orderDate: localDay(daysAgo(20)), checkedAt: Date.now(), checkedDay: 'x' },
      [id(453)]: { status: 'sent', orderDate: localDay(daysAgo(30)), checkedAt: Date.now(), checkedDay: 'x' },
    };
    const env = new Env(new Site({}), { store });
    await sleep(100);
    const left = Object.keys(env.store.statuses).sort().join(',');
    check('D1 closed windows forgotten; open ones kept', left === [id(452), id(453)].join(','), left);
  }

  // D2: a fallback from yesterday is forgotten: quick send is tried again today
  {
    const env = new Env(new Site({ [id(460)]: { age: 12, amazon: 'eligible' } }), { store: S4({ method: 'page', frameBlocked: true, switchedDay: localDay(daysAgo(1)) }) });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(460));
    check('D2 new day → quick send again', st(env, id(460)).status === 'sent' && env.posts[id(460)] === 1 && !env.bgTabs && !env.yesClicks[id(460)]);
    check('D2 sent orders remember when their window closes', /^\d{4}-\d{2}-\d{2}$/.test(st(env, id(460)).closesOn || ''));
  }

  // C1–C5: "Request review" only once Amazon should allow it (5 days after delivery)
  {
    const orders = {
      [id(201)]: { age: 6, transit: 5, amazon: 'notEligible' }, // delivered yesterday → opens in 4 days
      [id(202)]: { age: 6, transit: 8, status: 'delivered', amazon: 'eligible' }, // delivered early (before deliver-by) → at most today+5
      [id(203)]: { age: 10, transit: 4, status: 'inTransit', amazon: 'notEligible' }, // late: still in transit
      [id(204)]: { age: 7, noDeliverBy: true, status: 'none', amazon: 'notEligible' }, // no deliver-by: order date + 3 + 5
      [id(205)]: { age: 9, noDeliverBy: true, status: 'none', amazon: 'eligible' },
      [id(206)]: { age: 12, amazon: 'eligible' }, // delivered 8 days ago → open
    };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 6);
    check('C1 order placed 6 days ago but delivered yesterday → "Opens" in 4 days', label(w, id(201)) === `Opens ~${shortD(4)}`, label(w, id(201)));
    check('C2 marked delivered before its deliver-by date → opens by today + 5', label(w, id(202)) === `Opens ~${shortD(5)}`, label(w, id(202)));
    check('C3 still in transit past its deliver-by date → opens after tomorrow + 5', label(w, id(203)) === `Opens ~${shortD(6)}`, label(w, id(203)));
    check('C4 no deliver-by date → order date + 8 days', label(w, id(204)) === `Opens ~${shortD(1)}` && label(w, id(205)) === 'Request review', `${label(w, id(204))} / ${label(w, id(205))}`);
    const end = await sendAll(w);
    check('C5 Request Reviews only sends the ones that should be open', env.sends[id(205)] === 1 && env.sends[id(206)] === 1 && Object.keys(env.posts).length === 2, JSON.stringify(env.posts));
    check('C5 no "eligible, then not eligible" surprises', !Object.values(env.store.statuses || {}).some((r) => r.status === 'notEligible'), end);
  }


  // V: quick read-only lookups keep labels honest; saved results are only a fallback
  {
    const today = localDay();
    const y = localDay(daysAgo(1));
    const store = S4();
    store.statuses = {
      [id(603)]: { status: 'error', detail: 'Timed out waiting for Amazon.', checkedDay: today, checkedAt: Date.now() },
      [id(605)]: { status: 'unknown', detail: "Couldn't confirm it went through.", checkedDay: y, checkedAt: Date.now() - 86400000 },
      [id(606)]: { status: 'greyed', checkedDay: y, checkedAt: Date.now() - 86400000 },
    };
    const orders = {
      [id(601)]: { age: 12, amazon: 'already' }, // requested outside the extension
      [id(602)]: { age: 12, amazon: 'eligible' },
      [id(603)]: { age: 12, amazon: 'already' },
      [id(605)]: { age: 12, amazon: 'already' }, // "Needs a look" that did go through
      [id(606)]: { age: 12, amazon: 'eligible' }, // an old 0.8.2 guess
      [id(607)]: { age: 2, amazon: 'notEligible' }, // not open yet
    };
    const site = new Site(orders);
    site.getMode = 'json';
    const env = new Env(site, { store });
    const t0 = Date.now();
    const w = await ready(env, env.openList(), 6);
    await waitFor(() => label(w, id(601)) === 'Already requested' && label(w, id(605)) === 'Already requested' && label(w, id(603)) === 'Already requested', 15000, 'lookups').catch(() => {});
    const L = (n) => label(w, id(n));
    check('V1 requested outside the extension → "Already requested" before any tap', L(601) === 'Already requested', L(601));
    check('V2 eligible order stays "Request review"', L(602) === 'Request review', L(602));
    check('V3 a saved error is replaced by Amazon\'s answer', L(603) === 'Already requested', L(603));
    check('V4 "Needs a look" is settled by the lookup', L(605) === 'Already requested', L(605));
    check('V5 old greyed-button guesses are forgotten', L(606) === 'Request review', L(606));
    check('V6 lookups are fast: whole page in a few seconds', Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
    check('V7 lookups never send, open pages or press Yes', !env.posts && !Object.keys(env.visits).length && !Object.keys(env.yesClicks).length && !Object.keys(env.sends).length);
    await waitFor(() => st(env, id(607)).verifiedDay === today, 10000, '607').catch(() => {});
    check('V8 not-yet-open order: Amazon says not yet → stays "Opens ~"', /^Opens ~/.test(L(607)) && st(env, id(607)).status === 'notEligible', `${L(607)} ${st(env, id(607)).status}`);
    const end = await sendAll(w);
    check('V9 Request Reviews only sends the eligible ones', env.sends[id(602)] === 1 && env.sends[id(606)] === 1 && !env.posts[id(601)] && !env.posts[id(603)], JSON.stringify(env.posts));
    check('V9 summary', /^Done\. Sent 2\b/.test(end), end);
    const before = JSON.stringify(env.gets);
    const w2 = await ready(env, env.openList(), 6);
    await sleep(2500);
    check('V10 same-day reload → same labels, no new lookups', label(w2, id(601)) === 'Already requested' && label(w2, id(602)) === 'Sent ✓' && JSON.stringify(env.gets) === before, JSON.stringify(env.gets));
  }

  // V11: an endpoint that answers nothing useful → labels untouched, checking stops after 3 tries
  {
    const orders = {};
    for (let i = 611; i <= 616; i++) orders[id(i)] = { age: 12, amazon: i === 611 ? 'already' : 'eligible' };
    const env = new Env(new Site(orders), { store: S4() });
    const w = await ready(env, env.openList(), 6);
    await sleep(4000);
    check('V11 unclear replies change nothing and nothing turns red', Object.keys(orders).every((k) => label(w, k) === 'Request review'), Object.keys(orders).map((k) => label(w, k)).join(' | '));
    check('V11 gives up after 5 unreadable replies', Object.values(env.gets || {}).reduce((a, b) => a + b, 0) === 5, JSON.stringify(env.gets));
    const end = await sendAll(w);
    check('V12 the send gets Amazon\'s real answer: already → "Already requested", no error', label(w, id(611)) === 'Already requested' && /1 already requested/.test(end) && !/error/i.test(end), end);
  }

  // V13: clicking Request Reviews answers right away (spinner) and nothing waits long
  {
    const orders = {};
    for (let i = 621; i <= 626; i++) orders[id(i)] = { age: 12, amazon: 'eligible' };
    const site = new Site(orders);
    site.getMode = 'json';
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 6);
    await sleep(1400); // lookups under way
    launcherOf(w).click();
    const dot = launcherOf(w).querySelector('[data-dot]');
    check('V13 spinner shows the moment the button is clicked', launcherOf(w).getAttribute('aria-busy') === 'true' && /nudge-spin/.test(dot.style.animation), dot.style.animation);
    await waitFor(() => idle(w) && statusText(w), 60000, 'batch');
    check('V13 every order sent once, no leftovers', Object.keys(orders).every((k) => env.sends[k] === 1 && env.posts[k] === 1) && !env.store.currentJob && w.document.querySelectorAll('iframe').length === 0, JSON.stringify(env.posts));
  }

  // V14: Amazon's page says both "not eligible" and "already requested" → already
  {
    const store = S4({ method: 'page', frameBlocked: false, switchedDay: localDay() });
    const env = new Env(new Site({ [id(631)]: { age: 12, amazon: 'alreadyNoYes' } }), { store });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(631));
    check('V14 "already requested" wins over "not eligible" on Amazon\'s page', st(env, id(631)).status === 'already' && label(w, id(631)) === 'Already requested', `${st(env, id(631)).status} / ${label(w, id(631))}`);
  }

  // V15: an unfamiliar reason from Amazon is not guessed at
  {
    const env = new Env(new Site({ [id(641)]: { age: 12, amazon: 'eligible', reason: 'REVIEW_REQUEST_SOMETHING_NEW' } }), { store: S4() });
    const w = await ready(env, env.openList(), 1);
    await tap(env, w, id(641));
    check('V15 unknown Amazon reason → falls back to Amazon\'s page, not "not eligible"', st(env, id(641)).status !== 'notEligible', st(env, id(641)).status + ' ' + st(env, id(641)).detail);
  }


  // X: Option-click diagnostic is read-only and shows Amazon's answers
  {
    const orders = { [id(701)]: { age: 12, amazon: 'eligible' }, [id(702)]: { age: 12, amazon: 'already' }, [id(703)]: { age: 12, amazon: 'eligible' } };
    const site = new Site(orders);
    site.getMode = 'json';
    site.returns = [id(703)];
    site.fbaVia = 'link';
    site.fbaReturns = [];
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 3);
    await waitFor(() => label(w, id(703)) === '↩ Returned · skipped', 20000, 'return marked on load').catch(() => {});
    await sleep(1500);
    launcherOf(w).dispatchEvent(new w.MouseEvent('click', { bubbles: true, altKey: true }));
    await waitFor(() => /Use Copy/.test((w.document.querySelector('#nudge-diag textarea') || {}).value || ''), 60000, 'diagnostic');
    const txt = w.document.querySelector('#nudge-diag textarea').value;
    check('X1 diagnostic compares every label with Amazon', new RegExp(`${id(701)} · Request review · [^·]+ · can be requested`).test(txt) && new RegExp(`${id(702)} · Already requested · [^·]+ · already requested`).test(txt) && /agree with Amazon: 3 · disagree \(⚠\): 0/.test(txt), txt);
    check('X3 diagnostic reports both returns lists and where each return came from', /Manage Returns \(seller-fulfilled\): read via .* · 1 order with a return/.test(txt) && /Manage FBA returns: read · 0 orders/.test(txt) && new RegExp(`${id(703)} · ↩ Returned · skipped · .* · Manage Returns`).test(txt), txt);
    check('X4 a returned order is labelled on page load, before any run', label(w, id(703)) === '↩ Returned · skipped' && !(env.posts || {})[id(703)]);
    check('X2 diagnostic sends nothing and presses nothing', !env.posts && !Object.keys(env.yesClicks).length && !Object.keys(env.sends).length && idle(w));
  }


  // G: a run asks Amazon first and only sends what Amazon confirms today
  {
    const orders = {
      [id(801)]: { age: 20, amazon: 'eligible' },
      [id(802)]: { age: 38, amazon: 'notEligible' }, // estimate says still open; Amazon says the window closed
      [id(803)]: { age: 25, amazon: 'already' }, // requested elsewhere
      [id(804)]: { age: 22, amazon: 'notEligible' },
    };
    const site = new Site(orders);
    site.getMode = 'json';
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 4);
    launcherOf(w).click(); // straight away, before background lookups finish
    const sawChecking = await waitFor(() => /Checking \d+ of \d+ with Amazon/.test(launcherText(w)), 5000, 'checking label').then(() => true, () => false);
    const end = await waitFor(() => idle(w) && statusText(w), 60000, 'run');
    check('G1 run shows "Checking N of M with Amazon" first', sawChecking);
    check('G2 only the order Amazon confirmed is sent', env.posts && env.posts[id(801)] === 1 && !env.posts[id(802)] && !env.posts[id(803)] && !env.posts[id(804)], JSON.stringify(env.posts));
    check('G3 labels come from Amazon: already / not now', label(w, id(803)) === 'Already requested' && label(w, id(801)) === 'Sent ✓' && !/Request review/.test(label(w, id(802))), `${label(w, id(802))} | ${label(w, id(803))}`);
    check('G4 no errors in the summary', /^Done\. Sent 1\b/.test(end) && !/error/i.test(end), end);
  }

  // G5: tapping one order also asks first
  {
    const site = new Site({ [id(811)]: { age: 20, amazon: 'notEligible' } });
    site.getMode = 'json';
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    await stopBackground(env);
    btnOf(w, id(811)).click();
    await waitFor(() => st(env, id(811)).status === 'notEligible' && idle(w) && label(w, id(811)) !== 'Sending…', 15000, 'tap');
    check('G5 tap on an order Amazon says is not open → nothing sent', !env.posts, JSON.stringify(env.posts));
  }


  // F-empty: an FBA returns page with no returns (a seller who doesn't use FBA) counts as read
  {
    const site = new Site({ [id(901)]: { age: 12, amazon: 'eligible' } });
    site.getMode = 'json';
    site.fbaVia = 'link';
    site.fbaReturns = [];
    site.fbaEmptyText = 'No results found';
    const env = new Env(site, { store: S4() });
    const w = await ready(env, env.openList(), 1);
    await sleep(1500);
    launcherOf(w).dispatchEvent(new w.MouseEvent('click', { bubbles: true, altKey: true }));
    await waitFor(() => /Use Copy/.test((w.document.querySelector('#nudge-diag textarea') || {}).value || ''), 60000, 'diagnostic');
    const txt = w.document.querySelector('#nudge-diag textarea').value;
    check('F-empty: empty FBA returns page → read, 0 orders (not "couldn\'t be read")', /Manage FBA returns: read · 0 orders/.test(txt), txt.split('\n').slice(1, 5).join(' / '));
  }

  await sleep(300);
  console.log(`\nunhandled rejections: ${unhandled.length}${unhandled.length ? `\n${unhandled.slice(0, 5).join('\n---\n')}` : ''}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

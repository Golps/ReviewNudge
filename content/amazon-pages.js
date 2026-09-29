// Follows Amazon's own flow for one order:
//   order page → (check for return/refund) → Amazon's Request a Review page → "Yes"
// and reports what Amazon said.
//
// It can drive either
//   - an invisible frame inside your orders page (orders-page.js calls __nudgeDrive), or
//   - a background tab the extension opened (this file starts itself there).
// On any other Seller Central page it stays idle.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const POLL_MS = 400;
  const BUTTON_WAIT_MS = 10000; // wait this long for the order page's button
  const STAGE_TIMEOUT_MS = 30000; // wait this long on Amazon's review page
  const SETTLE_MS = 3000; // don't trust a "not eligible" message until the page has settled
  const STEP_DELAY_MIN_MS = 1500; // human-like pause before each step
  const STEP_DELAY_MAX_MS = 3000;
  const RETURNS_LOAD_MS = 25000; // wait this long for the returns list to show up
  const RETURNS_SETTLE_MS = 1500; // the list must stay unchanged this long before it's read
  const RETURNS_PAGE_MS = 15000; // wait this long for the next page of returns
  const RETURNS_MAX_PAGES = 200;
  const HELLO_TRIES = 8;
  const HELLO_RETRY_MS = 500;
  const US_MARKETPLACE_ID = 'ATVPDKIKX0DER';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  const CLICKABLE =
    'button, a, [role="button"], [role="link"], [role="menuitem"], kat-button, kat-link, input[type="button"], input[type="submit"]';
  const INTERACTIVE =
    'button, a, select, option, [role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="navigation"], nav, kat-button, kat-link, kat-dropdown, kat-menu';
  const SKIP_TEXT = 'script, style, noscript, template, #nudge-panel, #nudge-pop, [data-nudge-ui], [data-nudge-id]';
  const OUR_UI = '#nudge-panel, #nudge-pop, [data-nudge-ui], [data-nudge-id]';
  const KAT_TEXT_ATTRS = ['header', 'description', 'label', 'text', 'title', 'message'];

  const REQUEST_LABEL = /^request (?:a )?review$/i;
  const YES_LABEL = /^yes\b/i;
  const SENT =
    /review will be requested|review request (?:has been |was )?(?:sent|submitted)|request (?:has been |was )?(?:sent|submitted)|review (?:has been|was) requested/i;
  const ALREADY = /already (?:been )?requested|already requested a review|already sent a (?:review )?request/i;
  const INELIGIBLE =
    /not eligible|isn.t eligible|can.?t use this feature|cannot use this feature|outside (?:of )?the \d+\s*[-–]\s*\d+[- ]day/i;
  const CAPTCHA = /captcha|enter the characters you see|solve this puzzle/i;
  const VERIFY = /two-step verification|enter the (?:otp|one[- ]time|verification) code/i;

  // Skip-returns rule: objective return/refund facts shown on the order page.
  const RETURN_PATTERNS = [
    /\breturn (?:request(?:ed)?|authori[sz](?:ed|ation)|received|in transit|pending|approved|initiated|opened|started|completed|closed|reason)\b/i,
    /\brefund(?:ed|s? issued|s? processed|s? completed|s? initiated|s? pending|s? applied|s? requested)\b/i,
    /\b(?:item|items|order|package|unit|units)\s+(?:was |were |has been |have been )?returned\b/i,
    /\breturned (?:to|on|by|item|items|units?)\b/i,
  ];
  const NEGATED_BEFORE = /\b(?:no|not|without|zero)\s+(?:\w+\s+)?$/i;
  // A badge/label that is only a return or refund status, e.g. "Refunded", "Returned".
  const RETURN_BADGE = /^(?:(?:partially |fully )?refunded|returned|return (?:requested|pending|in progress|received|completed|authori[sz]ed)|refund (?:applied|issued|pending))$/i;
  const returnKindOf = (phrase) => (/refund/i.test(phrase) ? 'refund' : 'return');

  // ---------- reading a page (document, open shadow roots, same-origin iframes) ----------
  function allRoots(doc) {
    const out = [];
    const stack = [doc];
    while (stack.length) {
      const root = stack.pop();
      out.push(root);
      for (const e of root.querySelectorAll('*')) {
        if (e.shadowRoot) stack.push(e.shadowRoot);
        if (e.tagName === 'IFRAME' && !e.hasAttribute('data-nudge-ui')) {
          try {
            const d = e.contentDocument;
            if (d && d.documentElement) stack.push(d);
          } catch (err) {
            /* cross-origin frame */
          }
        }
      }
    }
    return out;
  }
  const deepAll = (doc, selector) => allRoots(doc).flatMap((r) => [...r.querySelectorAll(selector)]);

  const isVisible = (e) => e.getClientRects().length > 0;
  const inOurUi = (e) => !!e.closest(OUR_UI);
  const styleOf = (e) => (e.ownerDocument.defaultView || window).getComputedStyle(e);

  function isDisabled(e) {
    if (e.disabled === true || e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true') return true;
    const inner = e.shadowRoot && e.shadowRoot.querySelector('button');
    return !!(inner && inner.disabled);
  }

  function labelOf(e) {
    const raw =
      e.getAttribute('label') || e.getAttribute('aria-label') || (e.tagName === 'INPUT' ? e.value : '') || e.textContent || '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  const findButton = (doc, re) =>
    deepAll(doc, CLICKABLE).find((e) => !inOurUi(e) && re.test(labelOf(e)) && isVisible(e)) || null;

  function clickEl(e) {
    const inner = e.shadowRoot && e.shadowRoot.querySelector('button, a');
    (inner || e).click();
  }

  // Visible text, plus text Amazon's Katal components keep in attributes.
  // skipInteractive leaves out buttons/links/menus, so a "Refund order"
  // button doesn't count as a refund having happened.
  function pageText(doc, skipInteractive) {
    const parts = [];
    for (const root of allRoots(doc)) {
      const base = root.nodeType === 9 ? root.body : root; // Document → body; ShadowRoot → itself
      if (!base) continue;
      const d = root.nodeType === 9 ? root : root.ownerDocument;
      const walker = d.createTreeWalker(base, 4 /* SHOW_TEXT */);
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (!p || p.closest(SKIP_TEXT) || (skipInteractive && p.closest(INTERACTIVE)) || !isVisible(p)) continue;
        const t = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      for (const e of base.querySelectorAll('*')) {
        if (!e.tagName.startsWith('KAT-') || e.closest(SKIP_TEXT)) continue;
        if (skipInteractive && e.closest(INTERACTIVE)) continue;
        if (!isVisible(e) && styleOf(e).display !== 'contents') continue;
        for (const a of KAT_TEXT_ATTRS) {
          const v = e.getAttribute(a);
          if (v) parts.push(v.replace(/\s+/g, ' ').trim());
        }
      }
    }
    return parts.join(' | ');
  }

  // The piece of text around a match, for the explanation popup.
  function quote(text, re) {
    const m = re.exec(text);
    if (!m) return '';
    const start = text.lastIndexOf(' | ', m.index);
    const end = text.indexOf(' | ', m.index + m[0].length);
    const piece = text.slice(start < 0 ? 0 : start + 3, end < 0 ? text.length : end);
    return piece.length > 160 ? m[0] : piece;
  }

  function findReturn(text) {
    for (const piece of text.split(' | ')) {
      const t = piece.trim();
      if (RETURN_BADGE.test(t)) return t;
    }
    for (const re of RETURN_PATTERNS) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 20), m.index);
        if (!NEGATED_BEFORE.test(before)) return m[0];
      }
    }
    return null;
  }

  function sameOriginHref(e, base) {
    const a = e.tagName === 'A' ? e : e.closest('a[href]');
    const h = a && a.getAttribute('href');
    if (!h || h.startsWith('#') || /^javascript:/i.test(h)) return null;
    try {
      const u = new URL(h, base);
      return u.origin === new URL(base).origin ? u.href : null;
    } catch (err) {
      return null;
    }
  }

  // Amazon's "Request a Review" control on the order page.
  function findRequest(doc, orderId, base) {
    const candidates = deepAll(doc, CLICKABLE).filter((e) => !inOurUi(e) && REQUEST_LABEL.test(labelOf(e)));
    const shown = candidates.find(isVisible);
    if (shown) return { el: shown, href: sameOriginHref(shown, base), visible: true };
    // Hidden (e.g. in a closed "More" menu): usable only if it's a real link.
    for (const e of candidates) {
      const href = sameOriginHref(e, base);
      if (href) return { el: e, href, visible: false };
    }
    // Any link to Amazon's review page for this order.
    const link = deepAll(doc, 'a[href]').find((a) => {
      const h = a.getAttribute('href') || '';
      return h.includes(orderId) && /review|solicit/i.test(h) && !inOurUi(a);
    });
    const href = link && sameOriginHref(link, base);
    if (href) return { el: link, href, visible: isVisible(link) };
    return null;
  }

  const reviewPageUrl = (orderId, base, marketplaceId) =>
    `${new URL(base).origin}/messaging/reviews?orderId=${encodeURIComponent(orderId)}&marketplaceId=${marketplaceId || US_MARKETPLACE_ID}`;

  function blocker(doc, url, text) {
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch (err) {
      /* ignore */
    }
    if (/\/ap\/(signin|mfa|cvf)/.test(path) || doc.querySelector('input[type="password"]')) return 'Amazon asked you to sign in';
    if (VERIFY.test(text)) return 'Amazon asked for a verification code';
    if (CAPTCHA.test(text)) return 'Amazon showed a CAPTCHA';
    return null;
  }

  // ---------- one order ----------
  // io = { frame, doc(), url(), navigate(url) → 'continue' | 'handoff' | 'blocked', setStage(stage, note) → bool, report(result) }
  // Returns 'blocked' if the page couldn't be loaded invisibly (nothing reported), otherwise undefined.
  async function drive(job, io) {
    let stage = job.stage;
    let stageStart = Date.now();
    let negSeen = 0;
    // Amazon greys the order page's Request a Review button both when a request
    // was already sent and when the window isn't open. The button alone can't tell
    // them apart, so a greyed button is never a verdict: Amazon's review page is
    // read for the actual reason.
    let greyed = false;
    const lostContact = () =>
      io.report({ status: 'error', fatal: true, detail: 'Lost contact with the extension. Nothing was sent.' });

    for (;;) {
      const doc = io.doc();
      if (!doc || !doc.body) {
        if (Date.now() - stageStart > STAGE_TIMEOUT_MS) {
          return io.report({ status: stage === 'clickedYes' ? 'unknown' : 'error', fatal: stage === 'clickedYes', detail: "Amazon's page never loaded." });
        }
        await sleep(POLL_MS);
        continue;
      }
      const url = io.url();
      const text = pageText(doc, false);
      const block = blocker(doc, url, text);
      if (block) return io.report({ status: 'error', fatal: true, detail: block });

      if (stage === 'start') {
        const found = findRequest(doc, job.orderId, url);
        if (!found && Date.now() - stageStart < BUTTON_WAIT_MS) {
          await sleep(POLL_MS);
          continue;
        }
        // Let the rest of the order page load, like a person reading it.
        await sleep(rand(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
        const d2 = io.doc() || doc;
        const req = findRequest(d2, job.orderId, url) || found;
        if (!req && !pageText(d2, false).includes(job.orderId)) {
          return io.report({ status: 'error', detail: `The order page never showed order ${job.orderId}.` });
        }
        const ret = findReturn(pageText(d2, true));
        if (ret) return io.report({ status: 'skippedReturn', detail: `Order page says "${ret}".`, returnKind: returnKindOf(ret) });
        if (req && req.visible && isDisabled(req.el)) greyed = true;

        if (!greyed && !io.frame && req && !req.href && req.visible && !job.dryRun) {
          // A script button (no link) in a tab: click it, the way you would.
          if (!(await io.setStage('confirmPage'))) return lostContact();
          stage = 'confirmPage';
          stageStart = Date.now();
          negSeen = 0;
          clickEl(req.el);
          await sleep(POLL_MS);
          continue;
        }

        let target = req && req.href;
        let note = '';
        if (!target) {
          target = reviewPageUrl(job.orderId, url, job.marketplaceId);
          if (!req) note = "(No Request a Review button on the order page, so Amazon's review page was opened directly.)";
        }
        if (!(await io.setStage('confirmPage', note))) return lostContact();
        const nav = await io.navigate(target);
        if (nav === 'handoff') return undefined; // a new page in this tab continues the job
        if (nav === 'blocked') return 'blocked';
        stage = 'confirmPage';
        stageStart = Date.now();
        negSeen = 0;
        continue;
      }

      if (stage === 'confirmPage') {
        const yes = findButton(doc, YES_LABEL);
        const canYes = !!yes && !isDisabled(yes);
        if (canYes && /review/i.test(text)) {
          if (job.dryRun) {
            return io.report({
              status: 'eligible',
              detail: "Amazon's review page offered Yes/No, so this order is eligible. Check-only run stopped before Yes.",
            });
          }
          await sleep(rand(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS));
          const yes2 = findButton(io.doc() || doc, YES_LABEL);
          if (!yes2 || isDisabled(yes2)) continue;
          // Recorded before clicking, so Yes is never clicked twice for one order.
          if (!(await io.setStage('clickedYes'))) return lostContact();
          stage = 'clickedYes';
          stageStart = Date.now();
          negSeen = 0;
          clickEl(yes2);
          await sleep(POLL_MS);
          continue;
        }
        if (!canYes) {
          // "Already requested" wins over "not eligible": Amazon's page can say both.
          const neg = ALREADY.test(text) ? 'already' : INELIGIBLE.test(text) ? 'notEligible' : null;
          if (neg && Date.now() - stageStart >= SETTLE_MS && ++negSeen >= 2) {
            return io.report({ status: neg, detail: quote(text, neg === 'already' ? ALREADY : INELIGIBLE) });
          }
          if (!neg) negSeen = 0;
        }
        if (Date.now() - stageStart > STAGE_TIMEOUT_MS) {
          if (greyed) {
            return io.report({ status: 'notEligible', detail: "Amazon's Request a Review button is greyed out for this order." });
          }
          return io.report({
            status: 'error',
            detail: "Amazon's Request a Review page didn't show a Yes button or an eligibility message.",
          });
        }
      }

      if (stage === 'clickedYes') {
        if (SENT.test(text)) return io.report({ status: 'sent', detail: quote(text, SENT) });
        const neg = ALREADY.test(text) ? 'already' : INELIGIBLE.test(text) ? 'notEligible' : null;
        if (neg && Date.now() - stageStart >= SETTLE_MS && ++negSeen >= 2) {
          return io.report({ status: neg, detail: quote(text, neg === 'already' ? ALREADY : INELIGIBLE) });
        }
        if (!neg) negSeen = 0;
        if (Date.now() - stageStart > STAGE_TIMEOUT_MS) {
          return io.report({
            status: 'unknown',
            fatal: true,
            detail: "Yes was pressed but Amazon's answer couldn't be read. Open this order and check whether the request went through.",
          });
        }
      }

      await sleep(POLL_MS);
    }
  }

  // ---------- Manage Returns: every order with a return request, in any state ----------
  const ORDER_ID_G = /\b\d{3}-\d{7}-\d{7}\b/g;
  const RETURNS_TOTAL = [
    /Total Returns:?\s*(?:\|\s*)?([\d,]+)/i, // classic
    /Manage returns\s*(?:\|\s*)?\(\s*([\d,]+)\s*\)/i, // new
    /(?:^|\|)\s*([\d,]+)\s+items?\s*(?:\||$)/i, // FBA returns ("12 items")
  ];
  const FBA_ENTRY = /^(?:view |manage )?fba returns$|^fulfilled by amazon$|^amazon fulfilled$|^fba$/i;
  const SELLER_FULFILLED_MENU = /^seller fulfilled$/i;
  const FBA_PAGE = /Manage FBA returns|Customer refunded date|Unit received date/i; // only on the FBA returns page
  // FBA date filters, best first: the widest range on the page's date filter
  // (Amazon's FBA list is filtered by refund date; widest = fewest missed).
  const FBA_RANGES = [/^last year$/i, /^last 365 days$/i, /^last 180 days$/i, /^last 90 days$/i];
  const AUTHORIZED_FILTER = /return authori[sz]ed date/i;

  function readReturnsPage(doc) {
    const text = pageText(doc, false);
    let total = null;
    for (const re of RETURNS_TOTAL) {
      const m = text.match(re);
      if (m) {
        total = parseInt(m[1].replace(/,/g, ''), 10);
        break;
      }
    }
    const ids = text.match(ORDER_ID_G) || [];
    return { text, total, ids, sig: `${total}#${ids.join(',')}` };
  }

  // Waits until the list is readable and has stopped changing (and, if given,
  // differs from `before`). Returns the page, or { fail } with a reason.
  async function stableReturns(io, before, ms) {
    const start = Date.now();
    let last = null;
    let since = 0;
    for (;;) {
      const doc = io.doc();
      if (doc && doc.body) {
        const p = readReturnsPage(doc);
        const block = blocker(doc, io.url(), p.text);
        if (block) return { fail: block, blocked: true };
        const usable = p.total !== null && (p.ids.length > 0 || p.total === 0) && p.sig !== before;
        if (!usable) last = null;
        else if (!last || last.sig !== p.sig) {
          last = p;
          since = Date.now();
        } else if (Date.now() - since >= RETURNS_SETTLE_MS) return p;
      }
      if (Date.now() - start > ms) return { fail: before ? "the next page of returns didn't load" : "the returns list didn't load" };
      await sleep(POLL_MS);
    }
  }

  // Reads every page of the returns list. { ok, ids } or { ok: false, why }.
  // Only succeeds if it read at least as many rows as the page's own total.
  async function readReturns(io) {
    let page = await stableReturns(io, null, RETURNS_LOAD_MS);
    if (page.fail) return { ok: false, why: page.fail, blocked: !!page.blocked };
    const total = page.total;

    // Show the most rows per page Amazon offers (fewer pages to click through).
    if (page.ids.length < total) {
      const doc = io.doc();
      const sizes = deepAll(doc, 'select').filter((s) => [...s.options].some((o) => o.text.trim() === '10'));
      for (const s of sizes) {
        const biggest = [...s.options].sort((a, b) => (parseInt(b.text, 10) || 0) - (parseInt(a.text, 10) || 0))[0];
        if (!biggest || s.value === biggest.value) continue;
        const Ev = (s.ownerDocument.defaultView || window).Event;
        s.value = biggest.value;
        s.dispatchEvent(new Ev('input', { bubbles: true }));
        s.dispatchEvent(new Ev('change', { bubbles: true }));
        const bigger = await stableReturns(io, page.sig, RETURNS_PAGE_MS);
        if (!bigger.fail) page = bigger;
        break;
      }
    }

    const found = new Set();
    let rows = 0;
    for (let n = 0; n < RETURNS_MAX_PAGES; n++) {
      page.ids.forEach((id) => found.add(id));
      rows += page.ids.length;
      if (rows >= total) return { ok: true, ids: [...found], total };
      const next = findButton(io.doc(), /^next(?: page)?$/i);
      if (!next || isDisabled(next)) return { ok: false, why: `read ${rows} of ${total} returns` };
      clickEl(next);
      const after = await stableReturns(io, page.sig, RETURNS_PAGE_MS);
      if (after.fail) return { ok: false, why: `${after.fail} (read ${rows} of ${total})`, blocked: !!after.blocked };
      page = after;
    }
    return { ok: false, why: 'too many pages of returns' };
  }

  // From a (seller-fulfilled) Manage Returns page, open the FBA returns list and
  // read it too. { ok, ids } · { ok: false, missing: true } when this account
  // shows no FBA returns page · { ok: false, why, blocked? }.
  async function readFbaReturns(io) {
    const find = () =>
      deepAll(io.doc(), `${CLICKABLE}, [role="option"], kat-option`).find((e) => !inOurUi(e) && FBA_ENTRY.test(labelOf(e)) && isVisible(e)) || null;
    // A plain <select> switch between seller-fulfilled and FBA.
    for (const sel of deepAll(io.doc(), 'select')) {
      const opt = [...sel.options].find((o) => FBA_ENTRY.test(o.text.trim()));
      if (opt && !inOurUi(sel)) {
        const Ev = (sel.ownerDocument.defaultView || window).Event;
        sel.value = opt.value;
        sel.dispatchEvent(new Ev('change', { bubbles: true }));
        break;
      }
    }
    let entry = FBA_PAGE.test(pageText(io.doc(), false)) ? null : find();
    if (!entry) {
      const menu = findButton(io.doc(), SELLER_FULFILLED_MENU); // new layout: a "Seller fulfilled ▾" switch
      if (menu) {
        clickEl(menu);
        await sleep(POLL_MS * 2);
        entry = find();
      }
    }
    if (!entry) {
      await sleep(POLL_MS * 2);
      if (!FBA_PAGE.test(pageText(io.doc(), false))) return { ok: false, missing: true };
    }
    const href = entry && sameOriginHref(entry, io.url());
    if (!entry) {
      /* already switched by the <select> above */
    } else if (href) {
      if ((await io.navigate(href)) === 'blocked') return { ok: false, why: "the FBA returns page couldn't be opened" };
    } else {
      clickEl(entry);
    }
    // Wait for the FBA page itself.
    const start = Date.now();
    for (;;) {
      const doc = io.doc();
      const text = doc && doc.body ? pageText(doc, false) : '';
      const block = doc && doc.body ? blocker(doc, io.url(), text) : null;
      if (block) return { ok: false, why: block, blocked: true };
      if (FBA_PAGE.test(text)) break;
      if (Date.now() - start > RETURNS_LOAD_MS) return { ok: false, why: "the FBA returns page didn't load" };
      await sleep(POLL_MS);
    }
    // If the page can filter by *return authorized* date, use that (it lists a
    // return from the day it's authorized, before any refund).
    await useAuthorizedDateFilter(io);
    // Then widen the date range as far as the page allows.
    const choices = deepAll(io.doc(), 'label, [role="radio"], kat-radiobutton').filter((e) => !inOurUi(e));
    let range = null;
    for (const re of FBA_RANGES) {
      range = choices.find((e) => re.test(labelOf(e)));
      if (range) break;
    }
    if (range) {
      const input = range.querySelector && range.querySelector('input');
      const checked = (input && input.checked) || range.getAttribute('aria-checked') === 'true' || range.hasAttribute('checked');
      if (!checked) {
        const before = readReturnsPage(io.doc()).sig;
        clickEl(input || range);
        await stableReturns(io, before, RETURNS_PAGE_MS); // new results, or the same if nothing changed
      }
    }
    return readReturns(io);
  }

  // Switches the FBA list's date filter to "Return authorized date" when Amazon
  // offers that choice (a <select> or radio/option labelled that way).
  async function useAuthorizedDateFilter(io) {
    const doc = io.doc();
    for (const sel of deepAll(doc, 'select')) {
      const opt = [...sel.options].find((o) => AUTHORIZED_FILTER.test(o.text));
      if (opt && sel.value !== opt.value && !inOurUi(sel)) {
        const Ev = (sel.ownerDocument.defaultView || window).Event;
        const before = readReturnsPage(doc).sig;
        sel.value = opt.value;
        sel.dispatchEvent(new Ev('change', { bubbles: true }));
        await stableReturns(io, before, RETURNS_PAGE_MS);
        return true;
      }
    }
    const choice = deepAll(doc, 'label, [role="radio"], [role="option"], kat-radiobutton, kat-option')
      .find((e) => !inOurUi(e) && AUTHORIZED_FILTER.test(labelOf(e)) && !e.closest('th, thead, [role="columnheader"]') && isVisible(e));
    if (!choice) return false;
    const input = choice.querySelector && choice.querySelector('input');
    if ((input && input.checked) || choice.getAttribute('aria-checked') === 'true' || choice.getAttribute('aria-selected') === 'true') return true;
    const before = readReturnsPage(doc).sig;
    clickEl(input || choice);
    await stableReturns(io, before, RETURNS_PAGE_MS);
    return true;
  }

  // Shared with orders-page.js (same extension world).
  globalThis.__nudgeReadReturns = readReturns;
  globalThis.__nudgeReadFbaReturns = readFbaReturns;
  globalThis.__nudgeDrive = drive;
  globalThis.__nudgePageText = (doc) => pageText(doc, false);
  globalThis.__nudgeFindReturn = (text) => {
    const r = findReturn(text);
    return r ? { phrase: r, returnKind: returnKindOf(r) } : null;
  };

  // ---------- background-tab method: start automatically in a tab the extension opened ----------
  const send = (msg) => Promise.resolve(api.runtime.sendMessage(msg)).catch(() => null);

  function navigate(url) {
    location.assign(url);
  }

  (async () => {
    let stored;
    try {
      stored = await api.storage.local.get('currentJob');
    } catch (e) {
      return;
    }
    if (!stored || !stored.currentJob || stored.currentJob.mode === 'frame') return; // nothing for this tab
    for (let i = 0; i < HELLO_TRIES; i++) {
      const job = await send({ type: 'hello' });
      if (job) {
        return drive(job, {
          frame: false,
          doc: () => document,
          url: () => location.href,
          navigate: async (u) => {
            navigate(u);
            return 'handoff';
          },
          setStage: async (stage, note) => (await send({ type: 'stage', stage, note })) === true,
          report: (result) => send({ type: 'jobResult', result }),
        });
      }
      await sleep(HELLO_RETRY_MS);
    }
  })();
})();

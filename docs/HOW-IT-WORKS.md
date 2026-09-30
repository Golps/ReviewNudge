# How ReviewNudge works

A technical walkthrough for anyone who wants to check the logic before trusting it with their seller account. The code is [`background.js`](../background.js) and [`content/`](../content/), with [`manifest.json`](../manifest.json) at the top of the repository.

## Contents

1. [One code base, three browsers](#one-code-base-three-browsers)
2. [The pieces](#the-pieces)
3. [A run, step by step](#a-run-step-by-step)
4. [Asking Amazon about each order](#asking-amazon-about-each-order)
5. [Estimating the 5–30 day window](#estimating-the-530-day-window)
6. [Skipping returns and refunds](#skipping-returns-and-refunds)
7. [Sending a request](#sending-a-request)
8. [Never sending twice](#never-sending-twice)
9. [Moving through pages](#moving-through-pages)
10. [When it stops](#when-it-stops)
11. [What's stored, and for how long](#whats-stored-and-for-how-long)
12. [The diagnostic](#the-diagnostic)
13. [Testing](#testing)

## One code base, three browsers

ReviewNudge is a standard **Manifest V3 WebExtension**. The same folder loads unchanged in Chrome 121+, Firefox 142+ and Safari 17+:

| Difference between browsers | How ReviewNudge handles it |
|---|---|
| Chrome and Safari run the background as a *service worker*; Firefox uses an *event page* | `manifest.json` lists both `background.service_worker` and `background.scripts`. Each browser uses the one it supports and ignores the other. |
| `browser.*` (Firefox, Safari) vs `chrome.*` (Chrome) | `const api = globalThis.browser ?? globalThis.chrome`, with the promise-based calls all three support. |
| Replying to messages: Chrome ignores a returned Promise | The background answers with `sendResponse` and `return true`, which behaves the same everywhere. |
| Firefox runs a content script's `fetch()` as the extension | Requests to Amazon use `content.fetch()` when it exists, so Amazon sees them coming from the page, as in Chrome and Safari. Time limits are kept with a timer rather than an `AbortSignal`, which Firefox can't pass to the page. |
| Firefox add-on ID and data declaration | `browser_specific_settings.gecko`; other browsers ignore it. |
| The background can be suspended at any moment | All state is kept in `storage.local`; nothing important lives only in memory. |
| The extension is updated while Seller Central is open | The old copy of the page script notices it can't reach the extension anymore and asks you to reload the page, instead of hanging. |

## The pieces

| File | Role |
|---|---|
| `background.js` | Runs one order at a time and is the **only writer** of order results. Tracks each job's stage so a request can never be sent twice, and refuses to start an order that's already finished. Cleans up old results. |
| `content/orders-page.js` | Runs on Manage Orders: the **Request Reviews** button, the label under each order, the popups and the summary. Asks Amazon about each order, reads the returns lists, sends requests and moves through pages. |
| `content/amazon-pages.js` | Reads Amazon's pages: order numbers and totals on Manage Returns and Manage FBA returns, and, as a fallback, finds and clicks **Yes** on Amazon's own Request a Review page. |
| `content/orders-page.css` | Popup and notice styles. Labels use inline styles so they render correctly inside Amazon's shadow DOM. |

## A run, step by step

When Manage Orders opens, before any click:

1. **Scan.** Order numbers are found on the page (links, plain text or Amazon's shadow-DOM cards), and a label is placed under each one.
2. **Returns.** Manage Returns and Manage FBA returns are read in an invisible frame (see below). Matching orders become **↩ Returned · skipped**.
3. **Ask Amazon.** Every order that isn't finished or past its window is looked up once a day (see below), and its label updates.

When you click **Request Reviews**:

4. **Confirm.** Any order on the page not yet confirmed today is looked up now. The button shows *Checking 12 of 40 with Amazon · Stop*.
5. **Plan.** Only orders Amazon said today can be requested are queued. The delivery-date estimate decides only if Amazon's answer can't be read at all.
6. **Send**, one order at a time, with a random 3–6 second pause between orders.
7. **Next page.** When the page is done, Amazon's **Next** button is clicked, unless the page already reached orders past the 30-day window. Steps 4–6 repeat there.
8. **Summary.** For example:
   > **Done.**<br>Sent 63 · 3 returns/refunds skipped · 1 already requested.<br>Next batch: Sep 29 (4 orders), then Oct 1 (3 orders).

## Asking Amazon about each order

Saved results are a fallback, not the answer. Each order that isn't finished (sent, already requested, returned) or past its window gets one quick, read-only lookup a day:

- a `GET` of `/messaging/api/solicitations/{order}/productReviewAndSellerFeedback?marketplaceId=…`, the same check Amazon's own Request a Review page makes before it shows Yes/No. A GET only reads: nothing is sent, no page is opened, nothing is clicked;
- one order at a time, 0.25–0.55 seconds apart: orders that would be sent first, then orders not expected to be open yet. Labels update as answers arrive; a page of 100 orders takes under a minute.

Amazon's answer decides the label:

| Amazon's reply | Label |
|---|---|
| `{"isSuccess": true}` | **Request review** |
| `ineligibleReason: REVIEW_REQUEST_ALREADY_SENT` | **Already requested** (final) |
| Any other `ineligibleReason` (for example outside the time window) | **Opens ~date** or **Not eligible yet**, asked again tomorrow |
| No readable answer | unchanged |

A run and a tap on a single order always ask first, so nothing is sent to an order Amazon has closed or already has a request for. If five replies in a row can't be read (errors, not JSON), background lookups pause for 10 minutes; anything you start gives them a fresh chance. A sign-in redirect stops a run straight away. Only if Amazon's answer can't be read at all does ReviewNudge fall back to the delivery-date estimate, and even then the send itself returns Amazon's definite answer, so an already-requested order shows **Already requested**, never an error.

**Needs a look** (Yes was pressed but Amazon's answer wasn't seen) is settled the same way: if Amazon says a request exists, it becomes **Sent ✓**. If Amazon still accepts one on the same day, it stays as it is (Amazon may still be processing it) and is asked again after 10 minutes; on a later day it goes back to **Request review**.

## Estimating the 5–30 day window

Amazon allows a request from **5 to 30 days after delivery**, not after the order date. Amazon's own answer always wins, but the dates are still used to label orders before they're asked about, to skip lookups for orders clearly past the window, and to say when the next batch opens. ReviewNudge estimates delivery from each row:

| What the row shows | Delivery is taken as |
|---|---|
| A **Deliver by** date | That date (the latest promised day, so the estimate errs late, never early) |
| **Delivered** | Today at the latest |
| **In transit / Out for delivery** | Tomorrow at the earliest |
| No delivery date | Order date + 3 days |

- **Opens** = delivery + 5 days. Before that the label shows **Opens ~date**. These orders are still asked about once a day, after the ones that would be sent, in case a delivery came early.
- **Closes** = delivery + 30 days. After that, or when an order is more than 45 days old, the label shows **⊘ Past 30 days** and the order isn't asked about.
- When Amazon says "not eligible" for an order the dates call open, it shows **Not eligible yet** (or **⊘ Past 30 days** if it's over 30 days old) and is asked again the next day. It's never written off because Amazon said no once.

## Skipping returns and refunds

A buyer in the middle of a return or refund has no reason to get a review request, so ReviewNudge skips them. It checks three places:

1. **Manage Returns (seller-fulfilled)**, every status, last 90 days. It uses Seller Central's own *Manage Returns* menu link when the page has one, and otherwise the new and classic Manage Returns pages. It reads the page's own total (for example *Total Returns: 23*), sets the list to its largest page size, and clicks **Next** until it has read that many orders. Each order counts once per page, however often its number appears. Any order on the list is skipped: requested, pending, approved, completed, anything.
2. **Manage FBA returns**, right after: ReviewNudge follows Seller Central's own link or *Seller fulfilled ▾* switch to the FBA returns page and reads it the same way (its total is shown as *N items*; an empty list counts as read). It filters by **return authorized date** when the page offers that, so a return counts from the day it's authorized; otherwise it picks the widest date range available (up to *Last year*) on Amazon's default *customer refunded date* filter. If the page offers no way to FBA returns, the account has none and this step is skipped silently.
3. **The orders page itself**: a *Refunded* (or similar) label in an order's row. Phrases like *No refunds issued* are recognized as negations, and buttons such as *Refund order* are ignored.

The lists are read when Manage Orders opens, re-read every 15 minutes during long runs, and checked against orders that appear later (Amazon's **Next**, a filter change).

**Best effort by design.** If a list can't be read in full, ReviewNudge doesn't guess: it still skips every return it could read and every return shown on the orders page, keeps sending, and adds a line to the summary, for example *Manage FBA returns couldn't be read, so FBA returns not shown on the orders page may not have been skipped.* A CAPTCHA or sign-in page is different: see [When it stops](#when-it-stops).

## Sending a request

ReviewNudge only ever sends **Amazon's own Request a Review**, the fixed message Amazon writes. It tries three ways, in order:

1. **Quick send.** The same request Amazon's **Yes** button makes: `POST` to the address above with an empty body and the page's own security token. Amazon's answer is read directly: success, *already sent*, or *outside the time window*. Any other reason is never guessed at: the order goes through Amazon's page instead, where the wording is read (*already requested* wins over *not eligible*).
   - If the reply is lost (the connection drops, no answer in 20 seconds, or a server error), the request may still have gone through. ReviewNudge asks Amazon (the read-only lookup) before anything else: a request exists → **Sent ✓**; Amazon still accepts one → Amazon's page is tried; no clear answer → **Needs a look**, never a retry.
   - A redirect means Seller Central wants you to sign in: the run stops and nothing more is sent.
2. **Amazon's page, invisibly.** If the quick send is refused, ReviewNudge opens the order's page and Amazon's Request a Review page in an invisible frame and clicks **Yes**, exactly as you would.
3. **Amazon's page in a background tab**, if the browser won't show Amazon's page in a frame.

After two quick-send failures, the rest of that day uses Amazon's page directly. The next day (also in a tab left open overnight) it tries the quick send first again.

The marketplace (US, Canada, Mexico or Brazil) comes from each order's *Sales channel*, for the lookup, the quick send and Amazon's page alike.

## Never sending twice

Every order runs as a **job** in the background script with three stages: `start → confirmPage → clickedYes`. The stage is saved to storage **before** the request goes out.

- Every job has its own id. Messages about a job carry that id, so a late answer from a slow, abandoned order can never move or finish the next one.
- A job is never started for an order that's already finished (sent, already requested, returned, closed, needs a look), whatever the page shows.
- If anything goes wrong **before** `clickedYes`, nothing was sent. If it was a real failure, the order shows **Error – tap** and can be retried; if you simply reloaded or closed the page, nothing is recorded at all. **Error – tap** only appears when a request really failed; a failed *lookup* never sets it.
- If anything goes wrong **after** `clickedYes` (the page is reloaded, the tab closes, Amazon's answer never shows), the order is marked **Needs a look** and never retried automatically. A later lookup settles it (see above).
- Only one job can run at a time, even across several Seller Central tabs, and a double tap can't start two orders.

## Moving through pages

Manage Orders shows up to 100 orders per page, newest first. After finishing a page, ReviewNudge:

- **stops** if any order on the page is past the 30-day window (every later page is older still), or if there's no enabled **Next** button;
- otherwise clicks **Next**, waits until a different set of orders has loaded and settled, and continues. A page that doesn't change within 30 seconds stops the run, and the summary says so.

## When it stops

- You click the button again (**Stop**). It stops after the current order or lookup.
- Amazon shows a **CAPTCHA** or **sign-in** page, or redirects a lookup or request to sign-in, anywhere during the run, including while reading the returns lists. Nothing more is sent.
- **Two errors in a row**, or an order that ends as **Needs a look**.
- It reaches orders past the 30-day window, or the last page.

Every stop ends with the summary notice. When a specific order caused it, tapping the notice shows that order.

## What's stored, and for how long

`storage.local` only, on your computer:

| Key | Contents |
|---|---|
| `statuses` | Per order number: result, the day it was checked and the day Amazon last answered, order date, estimated window close, and a short explanation. |
| `currentJob` | The one order being processed right now: its stage, and the tab that's running it. Removed as soon as the order is done. |
| `settings` | Internal: which sending method is working today. There are no user settings. |

Each order's record is deleted a day after its review window closes (or 45 days after the order date if no delivery estimate was available).

## The diagnostic

Option-click (Alt-click) **Request Reviews** to check ReviewNudge against your own account. It sends no review request and changes nothing in Seller Central. To read the returns lists it uses their page-size, filter and **Next** controls inside an invisible copy of the page, as a run does. Amazon's fresh answers also refresh ReviewNudge's own labels. The text itself is kept nowhere: it disappears when you close the panel (which also stops the diagnostic), and its **Copy** button copies it.

**1. Returns.** Both lists are read fresh:

```
Manage Returns (seller-fulfilled): read via … · 3 orders with a return (last 90 days, any status)
Manage FBA returns: read · 1 order · filtered by return authorized date · range: Last year
```

or why a list couldn't be read (and what the page shows instead), or that the account has no FBA returns page.

**2. Every order on the page** (up to 100), one line each:

```
order · label shown · saved result · Amazon says · return found on
```

*Amazon says* comes from the read-only lookup in [Asking Amazon about each order](#asking-amazon-about-each-order). *Return found on* names Manage Returns, FBA returns and/or the orders list. A ⚠ marks a line where something disagrees: a label that contradicts Amazon, or an order with a return that would still be sent. The last lines give totals.

It exists so anyone can verify the extension against their own account, and so bug reports can include Amazon's actual answers.

## Testing

`npm test` runs the real extension files against a simulated browser and a simulated Seller Central: fake tabs, storage, background restarts, Amazon's orders, order, review, Manage Returns (new and classic) and FBA returns pages, CAPTCHAs, sign-in redirects, lost replies, page reloads mid-send, slow pages, double taps, pagination and more (114 checks). Messaging follows Chrome's rules, the strictest of the three browsers. `npm run lint` runs Mozilla's add-on checker.

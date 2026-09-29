# How ReviewNudge works

A technical walkthrough for anyone who wants to check the logic before trusting it with their seller account. The code is [`background.js`](../background.js) and [`content/`](../content/), with [`manifest.json`](../manifest.json) at the top of the repository.

## Contents

1. [One code base, three browsers](#one-code-base-three-browsers)
2. [The pieces](#the-pieces)
3. [A run, step by step](#a-run-step-by-step)
4. [Estimating the 5–30 day window](#estimating-the-530-day-window)
   - [Confirming each order with Amazon](#confirming-each-order-with-amazon)
5. [Skipping returns and refunds](#skipping-returns-and-refunds)
6. [Sending a request](#sending-a-request)
7. [Never sending twice](#never-sending-twice)
8. [Moving through pages](#moving-through-pages)
9. [When it stops](#when-it-stops)
10. [What's stored, and for how long](#whats-stored-and-for-how-long)
11. [The diagnostic](#the-diagnostic)
12. [Testing](#testing)

## One code base, three browsers

ReviewNudge is a standard **Manifest V3 WebExtension**. The same folder loads unchanged in Chrome 121+, Firefox 142+ and Safari 17+:

| Difference between browsers | How ReviewNudge handles it |
|---|---|
| Chrome and Safari run the background as a *service worker*; Firefox uses an *event page* | `manifest.json` lists both `background.service_worker` and `background.scripts`. Each browser uses the one it supports and ignores the other. |
| `browser.*` (Firefox, Safari) vs `chrome.*` (Chrome) | `const api = globalThis.browser ?? globalThis.chrome`, with the promise-based calls all three support. |
| Replying to messages: Chrome ignores a returned Promise | The background answers with `sendResponse` and `return true`, which behaves the same everywhere. |
| Firefox runs a content script's `fetch()` as the extension | The review request uses `content.fetch()` when it exists, so Amazon sees it coming from the page, as in Chrome and Safari. |
| Firefox add-on ID and data declaration | `browser_specific_settings.gecko`; other browsers ignore it. |
| The background can be suspended at any moment | All state is kept in `storage.local`; nothing important lives only in memory. |

## The pieces

| File | Role |
|---|---|
| `background.js` | Runs one order at a time and is the **only writer** of order results. Tracks each job's stage so a request can never be sent twice. Cleans up old results. |
| `content/orders-page.js` | Runs on Manage Orders: the **Request Reviews** button, the label under each order, the popups and the summary. Estimates windows, reads Manage Returns, sends requests and moves through pages. |
| `content/amazon-pages.js` | Reads Amazon's pages: counts and order numbers on Manage Returns, and, as a fallback, finds and clicks **Yes** on Amazon's own Request a Review page. |
| `content/orders-page.css` | Popup and notice styles. Labels use inline styles so they render correctly inside Amazon's shadow DOM. |

## A run, step by step

1. **Scan.** Order numbers are found on Manage Orders (links, plain text or Amazon's shadow-DOM cards), and a label is placed under each one.
2. **Confirm.** Orders that could be requested are looked up on Amazon (see below), so each label is current.
3. **Plan.** Every order whose label says **Request review** is queued.
4. **Returns.** Before the first send, Manage Returns is read in an invisible frame (see below). Matching orders become **↩ Returned · skipped**.
5. **Send**, one order at a time, with a random 3–6 second pause between orders.
6. **Next page.** When the page is done, Amazon's **Next** button is clicked, unless the page already reached orders past the 30-day window.
7. **Summary.** For example:
   > **Done.**<br>Sent 63 · 2 returns/refunds skipped · 1 already requested.<br>Next batch: Sep 29 (4 orders), then Oct 1 (3 orders).

## Estimating the 5–30 day window

Amazon allows a request from **5 to 30 days after delivery**, not after the order date. ReviewNudge estimates delivery from each row:

| What the row shows | Delivery is taken as |
|---|---|
| A **Deliver by** date | That date (the latest promised day, so the estimate errs late, never early) |
| **Delivered** | Today at the latest |
| **In transit / Out for delivery** | Tomorrow at the earliest |
| No delivery date | Order date + 3 days |

- **Opens** = delivery + 5 days. Before that the label shows **Opens ~date**.
- **Closes** = delivery + 30 days. After that, or when an order is more than 45 days old, the label shows **⊘ Past 30 days**.
- If Amazon still says "not eligible", the order shows **Not eligible yet** and is tried again the next day. It's never marked closed just because Amazon said no once.

## Confirming each order with Amazon

Saved results are a fallback, not the answer. When Manage Orders opens, and again after each run, every order that isn't finished and isn't past the window gets one quick, read-only lookup, unless it was already looked up **today**:

- a `GET` of `/messaging/api/solicitations/{order}/productReviewAndSellerFeedback`. That's the same check Amazon's own Request a Review page makes before it shows Yes/No. A GET only reads; nothing is sent, no page is opened, nothing is clicked;
- one order at a time, 0.25–0.55 seconds apart: orders that would be sent first, then orders not expected to be open yet. Labels update as answers arrive; a page of 100 orders takes under a minute.

Amazon's answer decides the label:

| Amazon's reply | Label |
|---|---|
| `{"isSuccess": true}` | **Request review** |
| `ineligibleReason: REVIEW_REQUEST_ALREADY_SENT` | **Already requested** (final) |
| Any other `ineligibleReason` (for example outside the time window) | **Opens ~date** or **Not eligible yet**, looked up again tomorrow |
| No readable answer | unchanged |

After five unreadable replies in a row (errors, not JSON), lookups stop for that visit. The send itself still returns Amazon's definite answer in under a second, so an already-requested order shows **Already requested**, never an error.

## Skipping returns and refunds

A buyer in the middle of a return or refund has no reason to get a review request, so ReviewNudge skips them. It checks two places:

1. **Manage Returns (seller-fulfilled)**, every status, last 90 days. It uses Seller Central's own *Manage Returns* menu link when the page has one, and otherwise the new and classic Manage Returns pages. It reads the page's own total (for example *Total Returns: 23*), sets the list to its largest page size, and clicks **Next** until it has read that many rows. Any order number on the list is skipped: requested, pending, approved, completed, anything.
2. **The orders page itself**: a *Refunded* (or similar) label in an order's row. Phrases like *No refunds issued* are recognized as negations, and buttons such as *Refund order* are ignored.

3. **Manage FBA returns**: right after the seller-fulfilled list, ReviewNudge follows Seller Central's own link or *Seller fulfilled ▾* switch to the FBA returns page and reads it the same way (its total is shown as *N items*). It filters by **return authorized date** when the page offers that, so a return counts from the day it's authorized; otherwise it picks the widest date range available (up to *Last year*) on Amazon's default *customer refunded date* filter. Accounts without an FBA returns page are skipped silently.

The lists are re-read every 15 minutes during long runs.

**Best effort by design.** If Manage Returns can't be read in full, ReviewNudge doesn't guess. It keeps sending, still skips orders the orders page marks as refunded, and adds a line to the summary: *Manage Returns couldn't be read, so only returns shown on the orders page were skipped.* A CAPTCHA or sign-in page is different: see [When it stops](#when-it-stops).

## Sending a request

ReviewNudge only ever sends **Amazon's own Request a Review**, the fixed message Amazon writes. It tries three ways, in order:

1. **Quick send.** The same request Amazon's **Yes** button makes: `POST /messaging/api/solicitations/{order}/productReviewAndSellerFeedback?marketplaceId=…` with an empty body and the page's own security token. Amazon's answer is read directly: success, *already sent*, or *outside the time window*. Any other reason is not guessed at: the order goes through Amazon's page instead, where the wording is read (*already requested* wins over *not eligible*).
2. **Amazon's page, invisibly.** If the quick send is refused, ReviewNudge opens the order's page and Amazon's Request a Review page in an invisible frame and clicks **Yes**, exactly as you would.
3. **Amazon's page in a background tab**, if the browser won't show Amazon's page in a frame.

After two quick-send failures, the rest of that day uses Amazon's page directly. The next day it tries the quick send first again.

The marketplace (US, Canada, Mexico or Brazil) comes from each order's *Sales channel*.

## Never sending twice

Every order runs as a **job** in the background script with three stages: `start → confirmPage → clickedYes`. The stage is saved to storage **before** the request goes out.

- If anything goes wrong **before** `clickedYes`, nothing was sent. The order shows **Error – tap** and can be retried. That label only appears when a request really failed; a failed *check* never sets it.
- If anything goes wrong **after** `clickedYes` (for example the tab closes before Amazon answers), the order is marked **Needs a look** and never retried automatically.
- Only one job can run at a time, even across several Seller Central tabs.

## Moving through pages

Manage Orders shows up to 100 orders per page, newest first. After finishing a page, ReviewNudge:

- **stops** if any order on the page is past the 30-day window (every later page is older still), or if there's no enabled **Next** button;
- otherwise clicks **Next**, waits until a different set of orders has loaded and settled, and continues. A page that doesn't change within 30 seconds stops the run.

## When it stops

- You click the button again (**Stop**). It stops after the current order.
- Amazon shows a **CAPTCHA** or **sign-in** page, anywhere during the run, including while reading Manage Returns. Nothing more is sent.
- **Two errors in a row.**
- It reaches orders past the 30-day window, or the last page.

## What's stored, and for how long

`storage.local` only, on your computer:

| Key | Contents |
|---|---|
| `statuses` | Per order number: result, check date, order date, estimated window close, and a short explanation. |
| `currentJob` | The one order being processed right now, and its stage. |
| `settings` | Internal: which sending method is working today. There are no user settings. |

Each order's record is deleted a day after its review window closes (or 45 days after the order date if no delivery estimate was available).

## The diagnostic

Option-click (Alt-click) **Request Reviews** to see what ReviewNudge sees, for up to five orders on the page (three it would send, two it considers done):

1. The order's label and its saved record.
2. The quick lookup above, with Amazon's reply.
3. The order's page, loaded invisibly: its **Request a Review** control and whether it's disabled.
4. Amazon's Request a Review page, loaded invisibly: its visible controls, and each data request it made, read again with `GET`.

Nothing is sent or clicked, email addresses are masked, and the text stays in the panel until you close it. It exists so that anyone can check the extension against their own account, and so bug reports can include Amazon's actual answers.

## Testing

`npm test` runs the real extension files against a simulated browser and a simulated Seller Central: fake tabs, storage, background restarts, Amazon's orders, order, review and Manage Returns pages (new and classic), CAPTCHAs, sign-in pages, pagination and more. Messaging follows Chrome's rules, the strictest of the three browsers. `npm run lint` runs Mozilla's add-on checker.

# Privacy

ReviewNudge is built for sellers who don't want to hand their store to a third-party service. Everything happens inside your own browser.

## The short version

- **No ReviewNudge servers.** There is nothing to sign up for and no account to create.
- **No data leaves your browser** except the requests to Amazon Seller Central described below, which are the same ones you make when you use Seller Central yourself.
- **No analytics, tracking, ads or third parties.** None.
- **Your password is never seen or stored.** ReviewNudge works inside the Seller Central session you're already signed in to.

## Permissions

| Permission | Why |
|---|---|
| Access to `https://sellercentral.amazon.com/*` | To add the button and labels to Manage Orders, read Manage Returns, ask Amazon whether each order can be requested, and send Amazon's review request. It doesn't run on any other website. |
| `storage` | To remember each order's result on your computer, so labels survive a page reload. |

That's all. ReviewNudge doesn't ask for your tabs, history, downloads, cookies or any other website.

## What it sends, and to whom

Only to `sellercentral.amazon.com`, as you:

1. **Manage Returns** and **Manage FBA returns**, opened in an invisible frame inside your orders page, to see which orders have a return.
2. **A read-only lookup for each order** that isn't finished, once a day: the same check Amazon's own Request a Review page makes (the order number and marketplace). It sends nothing to the buyer.
3. **Amazon's review request** for an order Amazon says can be requested. This is the same request Amazon's *Request a Review → Yes* button sends: the order number, the marketplace, and an empty message body.
4. **Amazon's own order and Request a Review pages**, only if the request above doesn't go through. ReviewNudge then clicks **Yes** on Amazon's page, just like you would.
5. **Amazon's Next button** on Manage Orders, to go to the next page of orders.

Nothing is sent anywhere else.

## What it stores on your computer

In your browser's extension storage (`storage.local`), for each order it has handled:

- the order number,
- the result (for example *sent*, *already requested*, *returned · skipped*),
- the day it was checked and the day Amazon last answered, the order date, and the estimated last day of its review window,
- a short explanation shown when you tap the label (for example "Amazon accepted the request.").

Plus two small internal entries: the one order being processed right now (removed as soon as it's done), and which sending method is working today. There are no user settings.

No buyer names, addresses, products, prices or messages are stored.

**Automatic cleanup:** each record is deleted a day after that order's 30-day review window closes, or 45 days after the order date if there was no delivery estimate. Removing the extension deletes everything.

## Firefox data declaration

The Firefox manifest declares `data_collection_permissions: none`, which is what Firefox Add-ons shows to users.

## Verifying this yourself

The whole extension is [`background.js`](../background.js) and [`content/`](../content/): about 2,900 lines of plain JavaScript, no libraries, no minified code. You can:

- search it for `fetch(`: the only direct network requests are the review request and its read-only lookup, both to `sellercentral.amazon.com` (everything else is Amazon's own pages, loaded in an invisible frame or a tab),
- open your browser's developer tools on Seller Central and watch the Network tab during a run,
- Option-click (Alt-click) **Request Reviews** to open the diagnostic, which shows each order's label next to Amazon's own answer. It sends no review request and changes nothing in Seller Central, and it keeps nothing: the text disappears when you close the panel.

## Questions or concerns

Open an issue, or for anything sensitive, a [private security advisory](https://github.com/Golps/ReviewNudge/security/advisories/new).

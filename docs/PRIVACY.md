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
| Access to `https://sellercentral.amazon.com/*` | To add the button and labels to Manage Orders, read Manage Returns, and send Amazon's review request. It doesn't run on any other website. |
| `storage` | To remember each order's result on your computer, so labels survive a page reload. |

That's all. ReviewNudge doesn't ask for your tabs, history, downloads, cookies or any other website.

## What it sends, and to whom

Only to `sellercentral.amazon.com`, as you:

1. **Manage Returns** and **Manage FBA returns**, opened in an invisible frame inside your orders page, to see which orders have a return.
2. **Amazon's review request for an eligible order.** This is the same request Amazon's *Request a Review → Yes* button sends: the order number, the marketplace, and an empty message body.
3. **A read-only lookup** of that same address for orders that could be requested, to see whether a request already exists. It sends nothing.
4. **Amazon's own order and Request a Review pages**, only if the request above doesn't go through. ReviewNudge then clicks **Yes** on Amazon's page, just like you would.
5. **Amazon's Next button** on Manage Orders, to go to the next page of orders.

Nothing is sent anywhere else.

## What it stores on your computer

In your browser's extension storage (`storage.local`), for each order it has handled:

- the order number,
- the result (for example *sent*, *already requested*, *returned · skipped*),
- the date it was checked, the order date, and the estimated last day of its review window,
- a short explanation shown when you tap the label (for example "Amazon accepted the request.").

No buyer names, addresses, products, prices or messages are stored.

**Automatic cleanup:** each record is deleted a day after that order's 30-day review window closes. Removing the extension deletes everything.

## Firefox data declaration

The Firefox manifest declares `data_collection_permissions: none`, which is what Firefox Add-ons shows to users.

## Verifying this yourself

The whole extension is [`background.js`](../background.js) and [`content/`](../content/): about 2,000 lines of plain JavaScript, no libraries, no minified code. You can:

- search it for `fetch(`: the only network requests are the review request and its read-only lookup, both to `sellercentral.amazon.com`,
- open your browser's developer tools on Seller Central and watch the Network tab during a run,
- Option-click (Alt-click) **Request Reviews** to open the read-only diagnostic, which shows each order's label next to Amazon's own answer. It sends nothing and keeps nothing: the text disappears when you close the panel.

## Questions or concerns

Open an issue, or for anything sensitive, a [private security advisory](https://github.com/Golps/ReviewNudge/security/advisories/new).

# Changelog

## 0.8.2

- **Labels are confirmed with Amazon, not just remembered.** Once a day, each order that could be requested is checked against the Request a Review button on Amazon's own order page (read only, never pressing Yes). Saved results are the fallback, so an order that was already requested, outside the extension or in an earlier session, now says **Already requested** instead of **Request review**.
- **One label for "ready".** *Eligible*, *Try again* and *Request review* were three names for the same thing. It's now just **Request review**.
- **Error means error.** **Error – tap** only appears when a request really failed today. A check that can't load Amazon's page says nothing and leaves the saved label alone.
- A greyed-out Request a Review button is no longer reported as "not eligible": Amazon greys it out when a request was already sent, too.
- When Amazon's page says both "not eligible" and "already requested", **Already requested** wins.
- A reason from Amazon that ReviewNudge doesn't recognize is never guessed at: it reads Amazon's page for the real answer instead.
- **Needs a look** clears itself once Amazon shows the order as already requested, or offers the button again.
- While a check is running, the label shows **Checking…**. Tap it to send right away.

## 0.8.1

- **FBA returns are now skipped too.** After the seller-fulfilled list, ReviewNudge reads Manage FBA returns, by return authorized date when the page offers it, otherwise over the widest date range.
- A CAPTCHA or sign-in page while reading returns stops the run instead of continuing.
- The Mexico marketplace is included in the returns check.
- The repository folder is the extension again (`manifest.json` at the top), so Safari, Chrome and Firefox load the folder you download or clone without picking a subfolder.

## 0.8.0 (first public release)

- One **Request Reviews** button on Manage Orders sends Amazon's own review request to every eligible order.
- A label under every order: Request review, Opens ~date, Sent ✓, Returned/Refunded · skipped, Already requested, Past 30 days.
- Follows Amazon's 5–30 day window, estimated from each order's delivery date.
- Skips orders on Manage Returns (any status) and orders the orders page marks as refunded.
- Works through every page of orders and stops at orders past the 30-day window.
- Summary with the next days more orders open, one sentence per line.
- Stops on a CAPTCHA or sign-in page, or after two errors in a row.
- One code base for Chrome (121+), Firefox (142+) and Safari (17+), Manifest V3.
- Private: no servers, no accounts, no data collected; results are stored locally and deleted after each order's window closes.

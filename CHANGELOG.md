# Changelog

## 0.8.1

- **FBA returns are now skipped too.** After the seller-fulfilled list, ReviewNudge reads Manage FBA returns, by return authorized date when the page offers it, otherwise over the widest date range.
- A CAPTCHA or sign-in page while reading returns stops the run instead of continuing.
- The Mexico marketplace is included in the returns check.

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

# Changelog

## 0.8.7

- **An empty returns list counts as read.** A real-account diagnostic showed Manage Returns read correctly (3 returns, all matched), but an empty Manage FBA returns page (a seller who doesn't use FBA) was reported as *couldn't be read*, because there was no count and no rows to wait for. A page that says it has no returns, or shows a count of zero, is now a complete read.
- If a returns page still can't be read, the diagnostic shows what the page says instead, so the wording can be supported.

## 0.8.6

- **The diagnostic checks returns too.** It reads Manage Returns and Manage FBA returns fresh and reports whether each was read, how, and how many returns it holds (and, for FBA, which date filter and range were used). Every order line now says where its return was found, and flags any order with a return that would still be sent.
- **Returns are read when Manage Orders opens**, not only when a run starts, so a returned order shows **↩ Returned · skipped** straight away instead of **Request review**.

## 0.8.5

- **Nothing is sent on an estimate anymore.** A run starts by asking Amazon about every order on the page not yet confirmed today (*Checking 12 of 40 with Amazon · Stop*), then sends only the orders Amazon says can be requested. Tapping a single order asks first too. Before, clicking Request Reviews before the background lookups finished could send to orders whose window the delivery-date estimate thought was still open, and Amazon answered *not eligible* or *already sent*.
- The date estimate is only used if Amazon's lookup can't be read at all.
- Diagnostic panel: a **Copy** button, and Cmd+A selects only the panel's text, not the page behind it.

## 0.8.4

- **Already requested is now detected before you send.** A real-account diagnostic showed that Amazon's quick check answers clearly: `REVIEW_REQUEST_ALREADY_SENT` for orders already requested, and `isSuccess: true` for orders that can be requested. 0.8.3 didn't recognize the second answer, so it switched checking off after the first few eligible orders and never reached the already-requested ones. Both answers are now read, and so is *not eligible yet*.
- Every order that isn't finished or past the window is looked up, once a day: orders that would be sent first, then orders not expected to be open yet. Labels update as answers arrive.
- Orders Amazon confirmed as eligible today keep that result when the browser restarts the extension's background.
- The diagnostic now lists **every** order on the page, with its label next to Amazon's answer, a ⚠ where they disagree, and totals. It's faster too: one quick lookup per order, no page loads. Documented in the README, *How it works* and *Privacy*.

## 0.8.3

- **Much faster, no more hanging.** 0.8.2 loaded each order's full Amazon page in the background to check it, several seconds per order. That's gone. Each order is now looked up with one small read-only request to the same Amazon address the Yes button uses (a GET, which never sends anything), a fraction of a second apart.
- **Already requested vs. ready.** When Amazon's lookup says a request already exists, the order shows **Already requested** before you tap anything. When the lookup gives no clear answer, the label is left alone, and after three unclear answers in a row checking stops for the day. The send itself then gets Amazon's definite answer (sent, already requested, or not open yet) in under a second.
- 0.8.2's "greyed-out button" guesses are forgotten: a greyed button didn't reliably mean *already requested*.
- **The Request Reviews button answers the moment you click it**: a spinning ring and *Starting…*, then *Sending 3 of 20 · Stop*.
- Shorter time limits, so a stuck Amazon page gives up in a minute instead of two.
- **Diagnostic:** Option-click (Alt-click) **Request Reviews** to see, for a few orders, exactly what Amazon answers. Read-only: nothing is sent or clicked.

## 0.8.2

- **Labels are confirmed with Amazon, not just remembered.** Once a day, each order that could be requested is checked against the Request a Review button on Amazon's own order page (read only, never pressing Yes). Saved results are the fallback, so an order that was already requested, outside the extension or in an earlier session, now says **Already requested** instead of **Request review**.
- **One label for "ready".** *Eligible*, *Try again* and *Request review* were three names for the same thing. It's now just **Request review**.
- **Error means error.** **Error – tap** only appears when a request really failed today. A check that can't load Amazon's page says nothing and leaves the saved label alone.
- A greyed-out Request a Review button is no longer reported as "not eligible": Amazon greys it out when a request was already sent, too.
- When Amazon's page says both "not eligible" and "already requested", **Already requested** wins.
- A reason from Amazon that ReviewNudge doesn't recognize is never guessed at: it reads Amazon's page for the real answer instead.
- **Needs a look** clears itself once Amazon shows the order as already requested, or offers the button again.
- While a check is running, the label shows **Checking…**. Tap it to send right away.
- The notice at the bottom of the screen is centred: the message sits in the middle, balanced by the close button.

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

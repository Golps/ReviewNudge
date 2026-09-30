# Changelog

## 1.0.0

First stable release. Checked on a real seller account: 100 of 100 labels matched Amazon's own answer, Manage Returns and Manage FBA returns were read correctly, and requests went through.

**What 1.0 does**

- One **Request Reviews** button on Manage Orders sends Amazon's own review request to every order Amazon says can be requested, page after page, one at a time with a 3–6 second pause.
- **Asks Amazon first.** Every order that isn't finished gets one read-only lookup a day (the same check Amazon's Request a Review page makes), so labels show Amazon's answer: **Request review**, **Already requested**, **Opens ~date**. Nothing is sent on a date estimate when Amazon's answer can be read.
- **Skips returns and refunds** from Manage Returns, Manage FBA returns and the orders page.
- **Never sends twice**, and never sends to a finished order.
- A summary with the next days orders open, and an Option-click **diagnostic** that checks every label against Amazon.
- Private: no servers, no accounts, nothing collected. Chrome, Firefox and Safari from one code base.

**Fixed in a full pre-release review** (each one now has its own test)

- Reloading or closing Seller Central while a request was in flight could lead to a second request for that order a few minutes later. The job now ends at once, and a lookup settles the order (**Sent ✓** when Amazon has it).
- A request whose reply was lost (connection drop, no answer in 20 seconds, server error) is confirmed with Amazon before anything else, instead of being retried through Amazon's page.
- A slow Amazon page answering late could finish the next order's job. Every job now has its own id, and a job is never started for an order that's already finished.
- Manage Returns lists that show each order number twice are read to the end; returns found on a partly read list are still skipped; an FBA returns page that can't be read is reported in the summary; returns are matched against orders that appear later (Amazon's Next, filters).
- Lookups that keep failing pause for 10 minutes instead of the rest of the day, and anything you start retries them. A sign-in redirect stops a run instead of trying to send.
- A double tap can't start two orders. Every stop shows its summary. Each return is counted once. An order over 30 days old isn't written off after a single "not eligible". **Needs a look** settles itself from Amazon's answer.
- Amazon's page fallback uses the order's own marketplace. A tab left open overnight starts the new day fresh. Closing the diagnostic stops it. After an extension update, the page asks you to reload instead of hanging.
- Removed leftovers from the testing versions (check-only mode, unused settings and counters).

## 0.8.0 – 0.8.7 (testing on a real account)

- **0.8.7** An empty returns list counts as read; the diagnostic shows a returns page's own wording when it can't be read.
- **0.8.6** The diagnostic checks Manage Returns and FBA returns; returns are read as soon as Manage Orders opens.
- **0.8.5** A run asks Amazon about every order before sending; diagnostic Copy button.
- **0.8.4** Amazon's lookup answers (`isSuccess`, `REVIEW_REQUEST_ALREADY_SENT`) read correctly, so **Already requested** shows before you send.
- **0.8.3** Read-only lookups instead of loading each order's page (much faster); the Request Reviews button shows a spinner as soon as it's clicked; first version of the diagnostic.
- **0.8.2** One **Request review** label instead of three; **Error – tap** only for real failures; centred notices.
- **0.8.1** FBA returns skipped too; a CAPTCHA or sign-in page while reading returns stops the run; Mexico included; the repository folder is the extension.
- **0.8.0** First public release: the Request Reviews button, a label under every order, the 5–30 day window estimated from delivery dates, Manage Returns and refunds skipped, every page of orders, a summary with the next batch, and Chrome, Firefox and Safari from one code base.

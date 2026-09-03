# GSAP Premium Animation Upgrade — what changed

This pass is animation-only, on top of your existing realtime-fix build.
Nothing about bidding, auth, the timer's actual countdown, Socket.IO, or
the database was touched.

## Files changed (only 2 existing files, both tiny, additive edits)

- `public/index.html` — added 2 lines: the GSAP CDN `<script>` tag, and a
  `<script src="/js/gsap-animations.js">` tag loaded last (after
  app.js/voice.js/admin.js).
- `public/css/styles.css` — added one small, new hover-lift rule for the
  dashboard/summary cards (purse tracker, join status, my team, auction
  summary, queue list). No existing CSS rule was edited or removed.

`diff` against your uploaded zip confirms every other file — `app.js`,
`admin.js`, and everything in `src/` — is byte-for-byte identical.

## New file: `public/js/gsap-animations.js`

This is the entire animation layer, and it's built to be safe by
construction:

1. **It never edits app logic.** It wraps already-defined functions
   (`renderPlayer`, `renderTeamTable`, `updateLeadingTeamRow`,
   `renderLiveBid`, `fireConfetti`, `fireUnsoldShake`, `enterApp`) —
   calling the *real* function first, unchanged, then layering an
   animation on top of the DOM it just produced. If GSAP fails to load,
   or any of these functions doesn't exist, the wrap is skipped and the
   app behaves exactly as before.
2. **Modals and screens are animated via `MutationObserver`**, watching
   the same `style.display` / `.hidden` class flips your code already
   makes — so every modal (squad, bid history, chat name, password
   change, confirm dialogs) and the login/admin/main-app screen
   transitions all get a fade+scale/slide, with zero changes to the
   click handlers that open/close them.
3. **Respects `prefers-reduced-motion`** independently of your existing
   CSS kill-switch, so it degrades safely on top of it.
4. **Bid-path animations are intentionally tiny.** The per-bid path
   (`renderLiveBid`, `updateLeadingTeamRow`) only pops the changed
   number and flashes the leading row — no stagger, no rebuild, so
   rapid bidding wars stay snappy. Fuller card/table staggers only run
   on the *infrequent* structural rebuilds (new player, sold, unsold),
   matching how your own code already splits "cheap" vs "full" renders.
5. **Only `transform`/`opacity` (plus a couple of one-shot color
   flashes) are animated** — no layout properties — and nothing loops
   forever, so there's nothing to leak or clean up.

## What you'll notice

- Login screen and the auction room fade/slide in on load.
- Dashboard-style cards (purse tracker, join status, summary, queue)
  lift subtly on hover.
- New player: badges, base price, current price, and status area
  stagger in (on top of your existing name-letter and card-enter
  animations, which are untouched).
- Bid amounts pop when they change; the leading team's row gets a
  brief gold flash.
- SOLD gets a quick card emphasis + pill pop layered on your existing
  confetti/sound; UNSOLD gets a quieter fade-in on the pill, on top of
  your existing shake.
- All modals fade/scale in and out.
- Buttons get a tiny, consistent press-down/release feel.

## To verify before your next draft

1. `npm install && npm start`, then click through: login, host controls,
   release a player, place bids from a couple of team tabs, mark
   SOLD/UNSOLD, open/close the squad and bid-history modals, resize to
   mobile width.
2. Open devtools console — there should be no new errors/warnings.
3. If anything ever looks off, the fastest rollback is to delete the two
   added `<script>`/CSS lines and the `gsap-animations.js` file — the
   rest of the app is completely unaffected either way.

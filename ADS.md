# Ads on the hosted site: structure only

The owner wants ads on the production site. This build has **reserved ad slots and nothing else**: no ad provider,
no SDK, no tracking, no account. They are **off** (`ads.enabled: false` in `config.js`) and never appear in the
Claude artifact.

## The slots

| Slot (`data-ad`) | Where | Reserved size |
|---|---|---|
| `below-game` | Under the game, after the drawing card (and the result card once shown) | 320 × 100 (mobile banner) |
| `result` | At the very end of the result card, after the stats and "Past days" | 300 × 250 (medium rectangle) |

Rules the layout keeps (and `npm run check` tests on the hosted build with ads on):

- **Never near the game.** No slot is between the map and the chart, or within 24 px of the map, the difficulty tabs,
  the drawing chart or its Undo / Clear / Submit buttons. A finger drawing near the bottom of the chart can't land on
  an ad.
- **No layout shift.** Each slot is shown at its full size as the page starts (before any ad could load), so nothing
  moves when an ad arrives, is empty or fails. The check measures layout shift (CLS < 0.05).
- **No overlap.** Slots are ordinary blocks in the page flow (no fixed or floating ads, no interstitials), with
  `contain: layout paint` and `overflow: hidden`, so an ad can never draw over the game.
- **Labelled** "Advertisement".

## Turning ads on later

1. Pick a provider and get approved (needs the public domain and a privacy policy).
2. In `config.js`: `ads: { enabled: true, slots: { "below-game": true, result: true } }`.
3. Load the provider's script after the page's `load` event (never before: a slow ad host must not delay the game) and
   fill the `.ad-fill` element of each slot. The page announces the slots with a `window` event,
   `elevation:ad-slots` (`event.detail.slots` is the list of slot elements).
4. Add the provider's hosts to the Content-Security-Policy in `site/_headers` (`script-src`, `img-src`, `frame-src`,
   `connect-src`).
5. Consent: personalised ads in the EU/UK need a consent banner (a certified CMP); add an `ads.txt` file at the site
   root as the provider asks.
6. Check that ad slot sizes still match the provider's units and that `npm run check` passes with ads on.

# Demo recording and promotional video

This repository contains a reproducible, local-only recording pipeline for the Next.js
reference UI and the real Stripe **test-mode** browser lifecycle. The output is a product
walkthrough, not a substitute for release evidence. Keep the default endpoint-based
browser gate and its private evidence record separate from promotional editing.

## Tools

The workflow uses open-source tooling already represented in the repository:

- Playwright and Chromium for deterministic browser capture;
- FFmpeg for masking, captions, transcoding, audio mixing, frame decoding, and contact
  sheets;
- Tesseract for a final forbidden-term privacy scan;
- the repository's disposable PostgreSQL and Stripe cleanup harnesses;
- `scripts/generate_promo_music.py` for an original, dependency-free background track.

Do not commit raw Checkout videos, Playwright traces, hosted URLs, cleanup manifests,
customer identifiers, or test emails. The generated paths live below ignored
`web/test-results/`.

## Record the public UI tour

Install the locked frontend dependencies and Chromium once:

```bash
cd web
npm ci
npx playwright install chromium
cd ..
```

Record the mock-data UI tour without Stripe or PostgreSQL:

```bash
PROMO_STEP_PAUSE_MS=1400 scripts/run_promo_ui.sh
```

The runner starts Next.js in explicit mock mode on a random loopback port, records one
1440 × 810 video, and removes the temporary process/log directory after success. The
mock banner is hidden only in the recording page; the actual development application
continues to display its warning.

## Record the real Stripe test-mode lifecycle

The normal release gate uses `E2E_WEBHOOK_TRANSPORT=endpoint`, creates a temporary
version-pinned Webhook Endpoint, verifies its metadata, and exercises signed delivery.
That remains the stronger transport/evidence mode:

```bash
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_TRANSITION_POLICY=prorated_delta \
E2E_RECORD_VIDEO=1 \
E2E_DEMO_PAUSE_MS=1200 \
scripts/run_browser_e2e.sh
```

A Quick Tunnel can be unavailable even when the application and Stripe are healthy. For
local diagnosis or recording, Stripe CLI signed forwarding is an explicit alternative:

```bash
E2E_WEBHOOK_TRANSPORT=stripe_cli \
E2E_STRIPE_EVENT_API_VERSION=<the CLI-delivered Event api_version> \
E2E_TRANSITION_POLICY=prorated_delta \
E2E_RECORD_VIDEO=1 \
E2E_DEMO_PAUSE_MS=1200 \
scripts/run_browser_e2e.sh
```

The CLI mode still forwards signed raw Events through `/webhooks/stripe`, runs the same
browser, PostgreSQL projection, exact Event/Invoice lineage verifier, incident check, and
strict account cleanup. It does **not** prove temporary endpoint creation, endpoint
metadata, or endpoint-specific API-version pinning. Do not report a CLI-mode pass as an
endpoint-mode pass.

The browser output uses one video per Playwright page. In the bundled lifecycle, the
primary page contains hosted Checkout and the initial success/account state; the second
page contains the Free/Starter account states, upgrade preview, upgrade SCA, and target
success state.

## Build the promotional cut

Build the public MP4 from the latest successful UI and prorated browser captures:

```bash
scripts/build_promo_video.sh
```

The editor:

- generates an original deterministic background track with
  `scripts/generate_promo_music.py`;
- matches safe milestone screenshots against both Playwright page videos with
  `scripts/locate_promo_frames.py` instead of relying on one run's hard-coded timestamps;
- cuts long webhook/network waits;
- adds stage captions and a persistent Stripe test-mode badge on real-payment clips;
- replaces the Checkout form area with opaque privacy panels;
- retains the decline, both test 3DS challenges, webhook-backed Starter/300 state,
  prorated `+700` preview, and Pro/1,000 state;
- pads bounded end-of-recording clips so audio and video remain aligned;
- produces H.264/YUV420p video and stereo AAC at 48 kHz;
- creates a poster; the review step creates the contact sheet and report.

By default the outputs are:

```text
web/test-results/promo-final/stripe-entitlements-fastapi-promo.mp4
web/test-results/promo-final/stripe-entitlements-fastapi-promo-poster.png
web/test-results/promo-final/stripe-entitlements-fastapi-promo-milestones.json
web/test-results/promo-final/stripe-entitlements-fastapi-promo-scenes.json
web/test-results/promo-final/review/contact-sheet.jpg
web/test-results/promo-final/review/report.md
```

Set `PROMO_CAPTURE_DIR` and `REAL_CAPTURE_DIR` to select another successful isolated
run. `PROMO_OUTPUT`, `PROMO_POSTER_OUTPUT`, `PROMO_MUSIC_OUTPUT`, and
`PROMO_MILESTONES_OUTPUT`, and `PROMO_SCENE_MANIFEST_OUTPUT` override generated
destinations. The scene manifest is generated from the same duration array used by
FFmpeg, so semantic review timestamps cannot silently drift when a clip length changes.
Never point the editor at an unreviewed production or live-mode recording.

## Frame and privacy review

Run the repeatable review gate:

```bash
scripts/review_promo_video.sh
```

The reviewer:

1. decodes every video frame into a `framemd5` record;
2. rejects decode failures and black segments longer than 0.35 seconds;
3. reports deliberate static holds longer than 2.5 seconds for visual review;
4. verifies codec, resolution, constant frame rate, pixel format, sample rate, channel
   layout, and audio/video duration alignment within 0.12 seconds;
5. measures integrated loudness and true peak with FFmpeg EBU R128 analysis;
6. extracts six payment/3DS checkpoints and rejects Tesseract matches for the test
   subject, email domain, card number, expiry, or cardholder name;
7. samples the complete public cut at 2 fps and applies the same forbidden-term privacy
   scan to every one of those full-frame samples;
8. samples the center of all 15 intentional scenes and verifies their expected captions,
   badges, and key plan/credit tokens after scaling, cropping, and encoding;
9. emits technical and semantic reports plus a contact sheet below the ignored output
   directory.

The verified `0.2.0` cut is 48.800 seconds, 1,464 decoded frames, 1920 × 1080 at
30 fps, H.264/YUV420p with 48 kHz stereo AAC, and -20.0 LUFS integrated loudness. It has
no detected black segment longer than 0.35 seconds, passes all six configured privacy
checkpoints and 98 full-frame OCR samples at 2 fps with zero forbidden-term matches, and
passes all 15 semantic scene checks.

The generated report is a technical gate, not a claim that OCR can prove the absence of
every possible identifier. Before publishing, also inspect the title, every scene
transition, payment masks, both 3DS screens, Starter/300, prorated preview, Pro/1,000,
and the final repository URL at full resolution.

## Public wording

Every published cut should visibly state:

```text
Stripe test mode
No real charge
Independent community project
```

Do not describe the video as live-mode, production-payment, arbitrary-invoice, or
exactly-once evidence. The browser return and SCA completion are demonstrations; the
account becomes enforceable only after the signed paid-Invoice webhook is projected by
PostgreSQL.

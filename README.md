# NPV E Block Shakurpur Delhi — Daily Attendance

A phone-friendly shared attendance register for **NPV E BLOCK SHAKURPUR DELHI**. The app supports date/class selection, prefilled previous or opening totals, daily admission/withdrawal/dormant counts, automatic class-strength and Absent calculations, preview-before-submit, duplicate protection, shared reports, separate Admin and Principal access, editable session settings, record corrections, and recoverable trash.

## Important: use one shared server URL

Uploading **only `public/index.html`** to Netlify creates a static website without the attendance API. That would leave phones with separate browser-only records. The app disables submission when a hosted page cannot reach its API rather than silently saving isolated entries. Opening the HTML file or adding `?local=1` is an explicit, device-only preview.

The complete project includes a Netlify Function backed by Netlify Blobs. Deploy the **whole project** and verify the API before entering real attendance.

## Netlify deployment

For the mobile-first single-ZIP workflow and verification steps, see [`NETLIFY-DEPLOY.md`](NETLIFY-DEPLOY.md). Try uploading the complete ZIP through Netlify Drop, then verify that `/api/config` returns JSON containing `today`, `groups`, `classes`, and `session`. Netlify may treat an uploaded project as static if it does not detect/build the Function; do not use that deployment for attendance unless the API check succeeds.

If ZIP detection does not deploy the Function, the guide also describes repository import and Netlify CLI alternatives. The included `netlify.toml` sets the publish folder and Function directory; the build command is `npm run build`.

## Run locally with the Node server

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open `http://localhost:4173`. For several phones on one Wi-Fi network, open the same computer’s LAN address on each phone. To share outside that network, deploy the project to Netlify or host the Node server on a persistent server.

## Attendance calculations

- **Current class strength** = Previous/Starting Total + Today Admission − Today Withdrawal − Today Dormant.
- **Absent** = Current class strength − Present.
- Daily movement counts are saved with each class/date record. Corrections replace that record’s current counts and preserve the previous and corrected values in history.
- Session totals add the configured opening movement balances to active daily entries from the configured session start date through the selected report date. Soft-deleting a record removes it from the totals; restoring it adds it back.

The initial session start date defaults to April 1, 2026, but it is not a user-confirmed date. Admin or Principal can change the date and set each class’s starting total plus opening admission, withdrawal, and dormant counts.

## Roles and default PINs

- **Admin** — default PIN `2468`: view reports and movement/correction history, allow one resubmission, change the Admin PIN, manage classes/sections, and edit session settings.
- **Principal** — default PIN `5678`: edit records for any date and move them across classes, move records to recoverable trash, restore records, allow resubmissions, manage classes/sections, edit session settings, and change both PINs.

The Admin and Principal remain signed in through a page refresh in the same browser session. Use **Log out** to explicitly end a session. Change both default PINs before public use. The app uses shared role PINs rather than individual teacher accounts.

## Classes included initially

Nursery; K.G.A, K.G.B; I A–C; II A–C; III A–C; IV A–C; V A–D. Admin and Principal can add, rename, or remove class groups and sections.

## Data and old static submissions

Records previously submitted while the old HTML-only deployment was in local-preview mode stayed in each phone’s browser storage. They were not uploaded to a shared database and will not appear automatically in a new shared deployment. On each original phone/browser, open the same site URL with `?local=1` to view that device’s local records. Re-enter any records that need to be kept in the shared register.

For a Node-server deployment, back up the persistent `data/attendance.json` file. On Netlify, persistent attendance is held in Netlify Blobs, not in the deployed HTML or ZIP.

# Deploy the shared attendance app to Netlify

## Important: deploy the complete project

Uploading only `public/index.html` creates a static page without the shared attendance API. Do not enter attendance until the API is live; otherwise the other phones will not see those entries. This project needs the Netlify Function and Netlify Blobs storage included in the ZIP.

## Mobile-first: try the complete ZIP with Netlify Drop

1. Download `daily-attendance-app.zip` and upload the **whole ZIP** at [Netlify Drop](https://app.netlify.com/drop) while signed in.
2. Wait for the deployment to finish, then open the deployed site’s `/api/config` path, for example `https://your-site.netlify.app/api/config`.
3. Continue only if the response is JSON containing `today`, `groups`, `classes`, and `session`. This confirms that the shared API is deployed. If the path shows a 404, an HTML page, or an error, the Function was not deployed; do not use that deployment for attendance.
4. Use the same verified site URL on every teacher, Admin, and Principal phone. Do not use separate deploy-preview links.

Netlify Drop’s source-project build behavior can depend on project detection. The `/api/config` check is required; an app page loading by itself does not prove that shared storage is working.

## If the ZIP route does not build the Function

Use a computer or a mobile workflow that can extract and import a project repository:

1. Extract the ZIP and upload all project files/folders to a Git repository. Keep `netlify.toml`, `package.json`, `netlify/functions/api.mjs`, and `public/index.html` in their existing locations.
2. In Netlify, import that repository as a site. The included `netlify.toml` sets `public` as the publish folder and `netlify/functions` as the Functions folder; the build command is `npm run build`.
3. Deploy, then verify `/api/config` as described above.

A CLI alternative is available from the extracted project folder with a current Node.js 22.13+ installation:

```bash
npm install
npx netlify login
npx netlify link
npx netlify build
npx netlify deploy --prod
```

Choose the existing Netlify site when linking if you want to keep that site URL.

## Session setup

The initial session start date defaults to April 1, 2026, but this is only a configurable default. After opening the Admin or Principal panel, go to **Session start and opening balances**. Confirm or change the start date and set each class’s starting total and opening admission, withdrawal, and dormant counts. Session movement totals then add current, active daily records from that date; corrections, soft deletes, and restores are reflected without double-counting.

## Default PINs

- Admin: `2468`
- Principal: `5678`

Change both before public use. The server uses shared role PINs rather than individual teacher accounts.

## Old local-only entries

Records previously entered on an HTML-only deployment were saved only in each phone’s browser and were not uploaded to a shared database. They are not migrated automatically. On each original phone/browser, the site URL with `?local=1` can still show that device’s local records; re-enter any records that need to be kept in the new shared register.

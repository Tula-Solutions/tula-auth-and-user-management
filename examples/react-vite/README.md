# @tula/react example (Vite)

A small React 19 app whose authentication is only `@tula/react`: `<SignUp>` with the live
password checklist, `<SignIn>` with forgotten password, `<UserButton>` and `<UserProfile>`,
behind `<SignedIn>` / `<SignedOut>`. The app itself adds a header, three routes and a theme
switch (`src/app.tsx`).

It is also what the browser tests drive (`e2e/`).

## Run it against a local API

From the repository root, with Docker running:

```bash
cp .env.example .env                 # once; set TULA_MASTER_KEY (openssl rand -hex 32)
docker compose up -d                 # Postgres, Redis, Mailpit (http://localhost:8025)
bun run db:migrate
bun run seed                         # prints the development environment's id
bun run api-key:create --environment <development environment id> --kind publishable
bun run dev                          # the API on http://localhost:3003
```

Then, in another terminal:

```bash
VITE_TULA_PUBLISHABLE_KEY=tula_pk_dev_… bun run --filter @tula/example-react-vite dev
```

Open <http://localhost:5174>. Emailed codes arrive in Mailpit. `VITE_TULA_API_URL` points the
app at another API (default `http://localhost:3003`); `.env.example` lists both. The key is
only ever passed in from outside: none is committed.

With `ENVIRONMENT=local` the API accepts any `http://localhost:<port>` origin. In another tier,
add `http://localhost:5174` to the environment's `urls.allowedOrigins` first.

## Browser tests

```bash
bun run e2e:install                  # once: Chromium for Playwright
bun run e2e                          # builds this app, serves it and the API, runs the suite
```

`e2e/server.ts` serves the **real API in process** on memory adapters (port 4318) and this
app's production build (port 4317), and exposes the emails it "sent" to the tests. It refuses
to start without `E2E=1` and is never part of the API image. The suite signs up, verifies,
signs in and out, resets and changes a password, manages sessions from two browsers, completes
sign-up with the keyboard only, and runs axe on every screen in light and dark.

## Screenshots

`docs/` holds the screenshots the package README shows; `bun run e2e:screenshots` regenerates
them.

| | |
| --- | --- |
| ![Sign-up with the live password checklist](docs/sign-up-checklist.png) | ![The emailed code](docs/verification.png) |
| ![Sign-in](docs/sign-in.png) | ![Dark](docs/dark-sign-in.png) |
| ![Account](docs/user-profile.png) | ![Phone](docs/mobile-sign-up.png) |

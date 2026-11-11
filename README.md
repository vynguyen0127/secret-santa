# Secret Santa

A tiny site: log in with your phone number, see who you're buying for and their wishlist, edit your own.

## Set up the Turso database (one time)

```bash
turso auth login                                  # opens the browser to sign in
turso db create secret-santa                      # create the database
turso db show secret-santa --url                  # copy this URL
turso db tokens create secret-santa               # copy this token
```

Copy `.env.example` to `.env` and paste the URL and token in:

```
TURSO_DATABASE_URL=libsql://secret-santa-yourname.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

Without a `.env` file the app uses a local `santa.db` file instead, which is handy for testing.

## Run the exchange

```bash
npm install
cp participants.example.json participants.json    # then edit with real names + phones
npm run load participants.json
npm run draw                                      # secret — never prints results
npm start                                         # http://localhost:3000
```

`npm run status` shows who's loaded and whether the draw is done, without revealing matches.
`npm run draw -- --force` redoes the draw (everyone gets a new recipient).

Recipients are hidden until you run `npm run reveal` — everyone sees a "you'll find out soon" message
instead. `npm run hide` hides them again. No restart needed.

## Keeping it secret

The site only ever shows someone who *they* give to. The only way to see every match is to
look inside the database directly (e.g. the Turso dashboard or `turso db shell`), so don't.
# secret-santa

# Public Goods Game — 150 player experiment platform

A repeated public goods game (contributions only) for live sessions of up to
150 players. React + Vite frontend, Supabase (Postgres + Realtime) backend.
Designed for a single experimenter console plus up to 150 mobile players
sharing a join code. Inspired by the parameters in Dhami, Wei and al Nowaihi
(2018), CESifo WP 7014, simplified to a pure contribution game.

## What's in this repo

src/App.tsx                Complete application. Frontend and game logic in
                           one file, React plus the Supabase JS client.
src/main.tsx               React entry point.
supabase.sql               Postgres schema + RLS policies + realtime
                           publication. Paste once into the Supabase SQL
                           editor and run.
.env.example               The two env vars Vercel needs.
vercel.json                Vercel build config + SPA rewrite.
index.html, vite.config.ts, tsconfig.json, package.json
                           Standard Vite scaffold.
LICENSE, .gitignore        Standard repo housekeeping.
AISTUDIO_BUILD_PROMPT.md   Optional. Specification you can paste into Google
                           AI Studio Build mode if you ever want it to
                           regenerate the UI from scratch.

## Setup, four steps

1. Create the Supabase project
   Go to supabase.com → New project. Pick a region close to your players
   (Singapore is the nearest free tier region to Gurugram). Wait for the
   project to provision (about a minute). Open Project Settings → API and
   note down the Project URL and the anon public key.

2. Run the schema
   In the Supabase dashboard open the SQL Editor, create a new query, paste
   the entire contents of supabase.sql, run. This creates four tables,
   row level security policies and adds the realtime publication. Verify in
   Database → Replication that players, rounds and contributions appear
   under the supabase_realtime publication.

3. Add the env vars to Vercel
   In Vercel, project settings → Environment Variables, add
       VITE_SUPABASE_URL          (the Project URL)
       VITE_SUPABASE_ANON_KEY     (the anon public key)
   for Production, Preview and Development. Trigger a redeploy after
   adding them.

4. Deploy
   Import the GitHub repo into Vercel. Build command npm run build,
   output directory dist, framework Vite. Vercel will give you a URL.
   Open it on your computer for the experimenter console, share the URL
   with players for the join screen.

## Local development

    cp .env.example .env.local
    # edit .env.local with your Supabase URL and anon key
    npm install
    npm run dev        # localhost:5173

## What the game does, in plain English

Experimenter creates a session and configures rounds (4 to 10), grouping
(one full pool or random groups of 10 to 15), endowment per round, MPCR
(return per token to each group member), round timer, the auto submit rule,
and whether groups reshuffle each round. Defaults are sensible (6 rounds,
groups of 12, endowment 20, MPCR 0.5, 90 second timer, auto submit at half
the round endowment, stranger matching). Creating a session generates a
five character join code.

Each round every player sees a fresh endowment and a token splitter, and
locks in a contribution before the timer expires. Anyone who misses the
timer is auto submitted at half their round share, flagged auto in the
data. Then payoffs are computed,

    payoff = (endowment − contribution) + MPCR × group_total

balances are credited, and players see a results screen. The experimenter
presses Start next round when ready. After the final round players see
their total earnings.

## Data captured, per player per round

Every contribution row records session, round, player id, name, gender,
field of study, group id, contribution, auto flag, submitted at iso,
response ms (decision latency from round start), payoff and balance after.
The experimenter console exports the whole dataset as one CSV with one row
per player per round. Opens cleanly in Excel, R, Stata.

## Engineering notes

Group totals and payoffs are computed by the experimenter's browser when
the round closes. Late submissions cannot overwrite an auto submission
because the contributions table primary key is (session, round, player id)
and a second insert on the same key is rejected. For a 150 player close
about 450 rows are written; chunked into upserts of 200 to stay polite on
the REST endpoint. Players who refresh mid session re-attach to their seat
via localStorage.

## Hardening for publishable research

The default RLS is open by design for a classroom experiment. For data you
intend to publish, enable Supabase Auth (anonymous sign in is fine), bind
each player row to its auth uid, and tighten the policies in supabase.sql
so contribution updates can only set payoff and balance_after when written
by a signed in admin. Two short policies, no schema change. Happy to write
those when you need them.

## Verify before a real session

I am confident in the game logic but you should pilot with 5 to 10 phones
before the real session, including one phone that deliberately misses the
timer, to confirm the auto submit and a mid round refresh behave as you
expect. Free tier Supabase supports the realtime concurrency this needs
(50 to 200 concurrent connections depending on current limits, verify on
supabase.com/pricing before a paid session). For 150 simultaneous players
the free tier should be enough but check the current limit.

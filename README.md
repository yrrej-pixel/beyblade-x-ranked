# Beyblade X Ranked Web App

Multi-view ranked system with **Supabase Auth**, player profiles, live challenges, and match scoring.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI (auth, dashboard, match lobby, scoring) + Tailwind + Supabase CDN |
| `app.js` | Modular vanilla JS (auth, players, challenges, realtime, scoring) |
| `supabase/schema.sql` | Tables, RLS, `submit_match_scores` RPC |

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. **Settings → API** → copy **Project URL** and **anon public** key

### 2. Run the database schema

1. **SQL Editor → New query**
2. Paste contents of `supabase/schema.sql` and **Run**

### 3. Enable Realtime (recommended)

1. **Database → Publications → `supabase_realtime`**
2. Add table **`match_requests`**

The app also polls every 8 seconds as a fallback.

### 4. Configure auth (development)

For instant sign-up without email confirmation:

**Authentication → Providers → Email** → disable **Confirm email** (dev only).

### 5. Configure the app

Edit `app.js` (top of file):

```javascript
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

### 6. Serve locally

ES modules require HTTP (not `file://`):

```bash
npx serve .
# or: python -m http.server 8080
```

Open `http://localhost:3000` (or the port shown).

## App flow

1. **Sign up** — email, password, unique username → row in `players`
2. **Dashboard** — rank, BR bar, accessories, challenge by username
3. **Match lobby** — incoming challenges with Accept / Decline; realtime updates
4. **Match screen** — both players when status is `accepted`; submit scores (winner = 4)
5. **RPC** — `submit_match_scores` updates both players (+25 / −15 BR), rank-up accessory, marks request `completed`

## BR rules

- Winner: **+25 BR**
- Loser: **−15 BR**
- BR &gt; 100: rank up, overflow carries, new accessory via RPC
- BR &lt; 0: rank down (floor at Bronze I)

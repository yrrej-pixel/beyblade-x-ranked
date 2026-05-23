/**
 * Beyblade X Ranked — username-only auth via fake email (@xbey.local)
 */

const SUPABASE_URL = window.BEYBLADE_CONFIG?.url ?? '';
const SUPABASE_ANON_KEY = window.BEYBLADE_CONFIG?.key ?? '';
const FAKE_EMAIL_DOMAIN = '@xbey.local'; // used only by formatFakeEmail

const WIN_BR = 25;
const LOSE_BR = 15;

const state = {
  session: null,
  player: null,
  activeMatch: null,
  pendingChallengeId: null,
  channel: null,
  pollId: null,
};

let supabase = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Fake email (never shown in UI) — "Ginka" → "ginka@xbey.local"
// ---------------------------------------------------------------------------
function formatFakeEmail(username) {
  return `${username.trim().toLowerCase()}${FAKE_EMAIL_DOMAIN}`;
}

function normalizeUsername(username) {
  const name = username.trim();
  if (name.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('Username can only use letters, numbers, and underscores.');
  }
  return name;
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
function getClient() {
  if (supabase) return supabase;
  const lib = window.supabase;
  const create = lib?.createClient ?? lib?.default?.createClient;
  if (!create) throw new Error('Supabase failed to load. Press Ctrl+F5.');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Missing BEYBLADE_CONFIG in index.html.');
  supabase = create(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabase;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const V = { AUTH: 'view-auth', DASH: 'view-dashboard', MATCH: 'view-match' };

function showView(id) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  $(id).classList.add('active');
  $('app-header').classList.toggle('hidden', id === V.AUTH);
}

function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setAuthMsg(text, err = false) {
  const el = $('auth-message');
  if (!text) return el.classList.add('hidden');
  el.textContent = text;
  el.className = `mt-4 text-sm text-center ${err ? 'text-red-400' : 'text-neon-green'}`;
  el.classList.remove('hidden');
}

function setChallengeMsg(text, err = false) {
  const el = $('challenge-msg');
  if (!text) return el.classList.add('hidden');
  el.textContent = text;
  el.className = `mt-2 text-sm ${err ? 'text-red-400' : 'text-neon-green'}`;
  el.classList.remove('hidden');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** Never use .single() / .maybeSingle() — both crash on 0 or 2+ rows. */
function firstRow(data) {
  if (!data?.length) return null;
  return data[0];
}

function friendlyDbError(err) {
  const msg = err?.message ?? '';
  if (err?.code === 'PGRST116' || msg.includes('coerce') || msg.includes('single JSON')) {
    return 'No matching record found.';
  }
  return msg || 'Database error.';
}

async function fetchRows(buildQuery) {
  const { data, error } = await buildQuery();
  if (error) throw error;
  return data ?? [];
}

async function fetchFirst(buildQuery) {
  return firstRow(await fetchRows(() => buildQuery().limit(1)));
}

// ---------------------------------------------------------------------------
// Auth tabs
// ---------------------------------------------------------------------------
function setupTabs() {
  const loginForm = $('form-login');
  const signupForm = $('form-signup');
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const login = btn.dataset.tab === 'login';
      document.querySelectorAll('.auth-tab').forEach((b) => {
        b.classList.toggle('tab-active', b.dataset.tab === (login ? 'login' : 'signup'));
        b.classList.toggle('border-white/10', b.dataset.tab !== (login ? 'login' : 'signup'));
        b.classList.toggle('text-slate-500', b.dataset.tab !== (login ? 'login' : 'signup'));
      });
      loginForm.classList.toggle('hidden', !login);
      signupForm.classList.toggle('hidden', login);
      setAuthMsg('');
    });
  });
}

/** Sign up with fake email; creates auth user + players row. */
async function handleSignUp(username, password) {
  const db = getClient();
  const display = normalizeUsername(username);
  const fakeEmail = formatFakeEmail(display);

  if (await isUsernameTaken(display)) {
    throw new Error('Username is already taken.');
  }

  const { data: authData, error: authError } = await db.auth.signUp({
    email: fakeEmail,
    password,
  });

  if (authError) {
    throw new Error(`Sign Up Error: ${authError.message}`);
  }

  if (!authData.user) {
    throw new Error('Sign up failed. Try again.');
  }

  const { error: profileError } = await db.from('players').insert({
    id: authData.user.id,
    username: display,
    bey_rating: 0,
    rank_tier: 'Bronze I',
    accessories: [],
  });

  if (profileError) {
    throw new Error(`Profile Creation Error: ${profileError.message}`);
  }

  // Email confirmation OFF → session is often available immediately
  if (authData.session) {
    state.session = authData.session;
    return { needsLogin: false };
  }

  const { data: signInData, error: signInError } = await db.auth.signInWithPassword({
    email: fakeEmail,
    password,
  });

  if (signInError) {
    return { needsLogin: true };
  }

  state.session = signInData.session;
  return { needsLogin: false };
}

/** Sign in with fake email derived from username. */
async function handleSignIn(username, password) {
  const fakeEmail = formatFakeEmail(username);

  const { data, error } = await getClient().auth.signInWithPassword({
    email: fakeEmail,
    password,
  });

  if (error) {
    const msg = error.message.toLowerCase().includes('invalid')
      ? 'Login Failed: Wrong username or password.'
      : `Login Failed: ${error.message}`;
    throw new Error(msg);
  }

  state.session = data.session;
}

async function signOut() {
  stopRealtime();
  await getClient().auth.signOut();
  state.session = null;
  state.player = null;
  state.activeMatch = null;
  hideChallengeModal();
  showView(V.AUTH);
}

// ---------------------------------------------------------------------------
// Player profile
// ---------------------------------------------------------------------------
async function loadPlayer() {
  const uid = state.session?.user?.id;
  if (!uid) return null;
  return fetchFirst(() => getClient().from('players').select('*').eq('id', uid));
}

function renderDashboard() {
  const p = state.player;
  if (!p) return;
  $('dash-username').textContent = p.username;
  $('dash-rank').textContent = p.rank_tier ?? 'Bronze I';
  const br = p.bey_rating ?? 0;
  $('dash-br-text').textContent = `${br} / 100`;
  $('dash-br-bar').style.width = `${br}%`;

  const items = Array.isArray(p.accessories) ? p.accessories : [];
  $('dash-accessories').innerHTML = items.length
    ? items.map((a) => `<li class="flex items-center gap-2 bg-edge/50 px-3 py-2 rounded clip-sm border border-white/5"><span class="w-1.5 h-1.5 rounded-full bg-neon-blue"></span>${esc(String(a))}</li>`).join('')
    : '<li class="text-slate-600 italic">None yet</li>';
}

/**
 * Safe username lookup — no .single(); handles 0, 1, or many rows.
 * @returns {Promise<object|null>} player row or null if not found
 */
async function lookupPlayerByUsername(enemyName) {
  const name = enemyName?.trim();
  if (!name) throw new Error('Enter an opponent username.');

  const rows = await fetchRows(() =>
    getClient().from('players').select('id, username').ilike('username', name)
  );

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error('Multiple players match that name. Use the exact username.');
  }
  return rows[0];
}

async function isUsernameTaken(name) {
  const rows = await fetchRows(() =>
    getClient().from('players').select('id').ilike('username', name.trim()).limit(1)
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Match requests
// ---------------------------------------------------------------------------
async function enrich(row) {
  if (!row) return null;
  const data = await fetchRows(() =>
    getClient()
      .from('players')
      .select('id, username')
      .in('id', [row.sender_id, row.receiver_id])
  );
  const map = Object.fromEntries(data.map((p) => [p.id, p]));
  return {
    ...row,
    sender: map[row.sender_id],
    receiver: map[row.receiver_id],
  };
}

async function sendMatchRequest(opponentUsername) {
  const enemy = await lookupPlayerByUsername(opponentUsername);

  if (!enemy) {
    setChallengeMsg('Player not found! Make sure you spelled their name right.', true);
    return;
  }

  if (enemy.id === state.player.id) {
    setChallengeMsg('You cannot challenge yourself.', true);
    return;
  }

  const existing = await fetchRows(() =>
    getClient()
      .from('match_requests')
      .select('id')
      .or(
        `and(sender_id.eq.${state.player.id},receiver_id.eq.${enemy.id}),and(sender_id.eq.${enemy.id},receiver_id.eq.${state.player.id})`
      )
      .in('status', ['pending', 'accepted'])
      .limit(1)
  );

  if (existing.length) throw new Error('A match is already pending with this player.');

  const myId = state.player.id;
  const rivalId = enemy.id;

  const { error } = await getClient().from('match_requests').insert({
    sender_id: myId,
    receiver_id: rivalId,
    status: 'pending',
  });
  if (error) throw error;

  setChallengeMsg(`Match request sent to ${enemy.username}!`);
  refreshOutgoing();
}

async function refreshOutgoing() {
  const data = await fetchFirst(() =>
    getClient()
      .from('match_requests')
      .select('*')
      .eq('sender_id', state.player.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
  );

  const el = $('outgoing-status');
  if (data) {
    const row = await enrich(data);
    el.textContent = `Waiting for ${row.receiver?.username ?? 'opponent'} to respond…`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function showChallengeModal(challengerName, requestId) {
  state.pendingChallengeId = requestId;
  $('modal-challenger-name').textContent = challengerName;
  const m = $('modal-challenge');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function hideChallengeModal() {
  state.pendingChallengeId = null;
  const m = $('modal-challenge');
  m.classList.add('hidden');
  m.classList.remove('flex');
}

async function respondChallenge(accept) {
  const id = state.pendingChallengeId;
  if (!id) return;
  hideChallengeModal();

  const db = getClient();
  const status = accept ? 'accepted' : 'declined';
  const { error } = await db
    .from('match_requests')
    .update({ status })
    .eq('id', id)
    .eq('receiver_id', state.player.id)
    .eq('status', 'pending');

  if (error) throw error;

  if (accept) {
    await loadActiveMatch(id);
    openMatchView();
    toast('Match accepted! Enter scores.');
  } else {
    toast('Challenge declined.');
  }
}

async function checkIncomingChallenge() {
  const data = await fetchFirst(() =>
    getClient()
      .from('match_requests')
      .select('*')
      .eq('receiver_id', state.player.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
  );

  if (!data || state.pendingChallengeId) return;
  const row = await enrich(data);
  showChallengeModal(row.sender?.username ?? 'A blader', data.id);
}

async function loadActiveMatch(requestId) {
  const data = await fetchFirst(() =>
    getClient().from('match_requests').select('*').eq('id', requestId)
  );
  if (!data) {
    state.activeMatch = null;
    return null;
  }
  if (data.status !== 'accepted') {
    state.activeMatch = null;
    return null;
  }
  state.activeMatch = await enrich(data);
  return state.activeMatch;
}

async function findActiveMatch() {
  const uid = state.player.id;
  const data = await fetchFirst(() =>
    getClient()
      .from('match_requests')
      .select('*')
      .eq('status', 'accepted')
      .or(`sender_id.eq.${uid},receiver_id.eq.${uid}`)
      .order('updated_at', { ascending: false })
  );

  if (data) {
    state.activeMatch = await enrich(data);
    return state.activeMatch;
  }
  state.activeMatch = null;
  return null;
}

function openMatchView() {
  const m = state.activeMatch;
  if (!m) return;

  const me = state.player.id;
  const foe = m.sender_id === me ? m.receiver?.username : m.sender?.username;

  $('match-you').textContent = state.player.username;
  $('match-foe').textContent = foe ?? 'Opponent';
  $('match-id').value = m.id;
  $('lbl-challenger').textContent = `${m.sender?.username ?? 'Sender'} score`;
  $('lbl-challenged').textContent = `${m.receiver?.username ?? 'Receiver'} score`;
  $('match-msg').classList.add('hidden');
  showView(V.MATCH);
}

function validateScores(a, b) {
  if (Number(a) === Number(b)) return 'Scores cannot tie.';
  if (Math.max(Number(a), Number(b)) !== 4) return 'Winner must reach 4 points.';
  return null;
}

async function submitScores() {
  const err = validateScores($('score-challenger').value, $('score-challenged').value);
  if (err) throw new Error(err);

  const { data, error } = await getClient().rpc('submit_match_scores', {
    p_request_id: $('match-id').value,
    p_sender_score: Number($('score-challenger').value),
    p_receiver_score: Number($('score-challenged').value),
  });
  if (error) throw error;

  state.activeMatch = null;
  state.player = await loadPlayer();
  renderDashboard();

  const won = data?.winner_id === state.session.user.id;
  toast(won ? `Victory! +${WIN_BR} BR` : `Defeat. −${LOSE_BR} BR`);

  if (data?.rank_up && won) {
    $('rankup-tier').textContent = data.new_rank_tier ?? state.player.rank_tier;
    $('rankup-item').textContent = data.new_accessory ?? 'New accessory';
    $('modal-rankup').classList.remove('hidden');
    $('modal-rankup').classList.add('flex');
  }

  showView(V.DASH);
  refreshOutgoing();
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
function stopRealtime() {
  if (state.channel && supabase) supabase.removeChannel(state.channel);
  state.channel = null;
  if (state.pollId) clearInterval(state.pollId);
  state.pollId = null;
}

function startRealtime() {
  stopRealtime();
  const db = getClient();
  const uid = state.player.id;

  state.channel = db
    .channel(`lobby-${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_requests' }, async (payload) => {
      const row = payload.new ?? payload.old;
      if (!row) return;
      if (row.sender_id !== uid && row.receiver_id !== uid) return;

      if (payload.eventType === 'INSERT' && row.receiver_id === uid && row.status === 'pending') {
        const e = await enrich(row);
        showChallengeModal(e.sender?.username ?? 'A blader', row.id);
      }

      if (row.status === 'accepted') {
        await loadActiveMatch(row.id);
        if (state.activeMatch) {
          openMatchView();
          toast(row.sender_id === uid ? 'Waiting for scores…' : 'Match live — enter scores!');
        }
      }

      if (row.status === 'completed') {
        state.activeMatch = null;
        state.player = await loadPlayer();
        renderDashboard();
        if ($(V.MATCH).classList.contains('active')) showView(V.DASH);
      }

      refreshOutgoing();
    })
    .subscribe();

  state.pollId = setInterval(() => {
    checkIncomingChallenge();
    findActiveMatch().then((m) => { if (m) openMatchView(); });
    refreshOutgoing();
  }, 8000);
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------
async function enterDashboard() {
  state.player = await loadPlayer();
  if (!state.player) {
    setAuthMsg('Profile missing. Sign up again or run supabase/schema.sql.', true);
    showView(V.AUTH);
    return;
  }
  renderDashboard();
  showView(V.DASH);
  await refreshOutgoing();
  await checkIncomingChallenge();
  const active = await findActiveMatch();
  if (active) openMatchView();
  startRealtime();
}

async function boot() {
  window.BEYBLADE_APP_READY = true;
  showView(V.AUTH);
  setupTabs();
  bindEvents();

  try {
    const db = getClient();
    const { data } = await db.auth.getSession();
    state.session = data.session;
    if (state.session) await enterDashboard();
  } catch (e) {
    console.error(e);
    setAuthMsg(e.message, true);
  }

  getClient().auth.onAuthStateChange(async (event, session) => {
    state.session = session;
    if (event === 'SIGNED_IN' && session) await enterDashboard();
    if (event === 'SIGNED_OUT') {
      stopRealtime();
      showView(V.AUTH);
    }
  });
}

function bindEvents() {
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthMsg('');
    try {
      await handleSignIn($('login-username').value, $('login-password').value);
      await enterDashboard();
      toast('Logged in successfully!');
    } catch (err) {
      setAuthMsg(friendlyDbError(err), true);
    }
  });

  $('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthMsg('');
    try {
      const result = await handleSignUp($('signup-username').value, $('signup-password').value);

      if (result.needsLogin) {
        setAuthMsg('Account created successfully! You can now log in.');
        document.querySelector('[data-tab="login"]')?.click();
        return;
      }

      await enterDashboard();
      toast('Account created — welcome to the arena!');
    } catch (err) {
      setAuthMsg(friendlyDbError(err), true);
    }
  });

  $('btn-sign-out').addEventListener('click', signOut);

  $('form-challenge').addEventListener('submit', async (e) => {
    e.preventDefault();
    setChallengeMsg('');
    try {
      await sendMatchRequest($('challenge-username').value);
      $('challenge-username').value = '';
    } catch (err) {
      setChallengeMsg(friendlyDbError(err), true);
    }
  });

  $('btn-accept').addEventListener('click', () => respondChallenge(true).catch((e) => toast(e.message)));
  $('btn-decline').addEventListener('click', () => respondChallenge(false).catch((e) => toast(e.message)));

  $('form-scores').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('match-msg');
    msg.classList.add('hidden');
    try {
      await submitScores();
    } catch (err) {
      msg.textContent = friendlyDbError(err);
      msg.className = 'mt-3 text-sm text-center text-red-400';
      msg.classList.remove('hidden');
    }
  });

  $('btn-back-dash').addEventListener('click', () => showView(V.DASH));
  $('btn-rankup-close').addEventListener('click', () => {
    $('modal-rankup').classList.add('hidden');
    $('modal-rankup').classList.remove('flex');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

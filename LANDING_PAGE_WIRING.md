# Wiring toerillagignetwork.com to the real backend

I pulled the live page's sign-up form to see exactly what's there today. Right
now it's a demo stub — here's the actual `<form>` markup as it exists live:

```html
<form onsubmit="event.preventDefault(); document.getElementById('formMsg').style.display='block';">
  <div class="field">
    <label for="fname">Name</label>
    <input type="text" id="fname" placeholder="Your name" required>
  </div>
  <div class="field">
    <label for="fbiz">Venue / band name</label>
    <input type="text" id="fbiz" placeholder="e.g. The Sandbar, or your band name">
  </div>
  <div class="field">
    <label for="farea">City & State</label>
    <input type="text" id="farea" placeholder="e.g. Austin, TX">
  </div>
  <div class="field">
    <label for="fcontact">Phone or Instagram</label>
    <input type="text" id="fcontact" placeholder="Best way to reach you" required>
  </div>
  ...
  <button type="submit" class="submit-btn">Join the Early List</button>
  <p class="form-foot" id="formMsg" style="display:none;">Thanks — you're on the list. (Demo form — connect to your backend before launch.)</p>
</form>
```

There's also a role toggle elsewhere on the page (`#roleVenue` / `#roleMusician`
buttons) that currently only changes the "Venue / band name" label text — it
doesn't track which one is selected anywhere a form submission could use.

## What to change

**1. Give the form an id**, so it's easy to select in JS. Change the opening
`<form ...>` tag to:

```html
<form id="signupForm">
```

(This removes the old inline `onsubmit="..."` — the new JS below replaces it.)

**2. Add this script** right before `</body>` (or append it to the existing
inline `<script>` block that already defines `roleVenue`/`roleMusician` —
either works, just don't declare `roleVenue`/`roleMusician` twice):

```html
<script>
(function () {
  // TODO: replace with your real deployed backend URL once you've deployed
  // (see README.md "Deploying to Railway"), e.g.
  // 'https://toerilla-backend-production.up.railway.app'
  const API_BASE_URL = 'https://YOUR-BACKEND-URL.example.com';

  const form = document.getElementById('signupForm');
  const formMsg = document.getElementById('formMsg');
  const submitBtn = form.querySelector('.submit-btn');

  function currentRole() {
    // Matches the existing toggle buttons' 'active' class.
    return document.getElementById('roleVenue').classList.contains('active') ? 'venue' : 'musician';
  }

  // "City, ST" -> { city, state }. Falls back gracefully if there's no comma.
  function parseCityState(raw) {
    const parts = (raw || '').split(',').map((s) => s.trim());
    if (parts.length >= 2) return { city: parts[0], state: parts[1] };
    return { city: parts[0] || '', state: '' };
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Joining...';

    const role = currentRole();
    const { city, state } = parseCityState(document.getElementById('farea').value);

    const payload = {
      name: document.getElementById('fbiz').value || document.getElementById('fname').value,
      contact_name: document.getElementById('fname').value,
      contact_phone: document.getElementById('fcontact').value,
      city,
      state,
      claim_founding_member: true, // early-access signups are eligible while the first 100 slots last
    };

    const endpoint = role === 'venue' ? '/api/venues' : '/api/musicians';

    try {
      const res = await fetch(API_BASE_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Request failed: ' + res.status);

      formMsg.textContent = "Thanks — you're on the list. We'll text you as gigs come up.";
      formMsg.style.display = 'block';
      form.reset();
    } catch (err) {
      formMsg.textContent = 'Something went wrong — mind trying again in a moment?';
      formMsg.style.display = 'block';
      console.error('Signup failed:', err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Join the Early List';
    }
  });
})();
</script>
```

## Notes / things I simplified

- **Musician genres/instruments/reach aren't collected by this form at all**
  — it's a lightweight early-access list, not a full musician profile. The
  backend defaults new musicians to `reach: 'local'` and empty genres, which
  means they won't actually get matched to gigs until that profile is filled
  in. You'll want either a follow-up onboarding email/form, or to add those
  fields to this form before relying on real matching. Flagging this so it
  doesn't surprise you later.
- **Referral tracking isn't wired** — the page mentions "Refer a friend" but
  there's no input field or `?ref=` link param to capture who referred whom.
  If you want that live, the backend already supports it (`referred_by` /
  `referrer_type` in the POST body) — it just needs a form field or query
  param added on this end.
- **"Phone or Instagram"** is stored as-is in `contact_phone`. If someone
  enters an Instagram handle instead of a phone number, they obviously won't
  get SMS notifications about gig matches — worth a note on the form, or
  splitting into two fields, before you're relying on SMS as the primary
  notification channel.
- CORS is already open on the backend (`ALLOWED_ORIGIN=*` by default) so
  this will work cross-origin against Railway/Render/Fly immediately. Once
  things are stable, tighten `ALLOWED_ORIGIN` in your backend's env vars to
  `https://toerillagignetwork.com` only.

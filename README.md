# Study Planner — Firebase Setup & Deployment

This adds Student registration/login (Student ID + Password only), live
activity tracking, and a hidden Admin Dashboard on top of the existing
Study Planner. The UI, tasks, timer, calendar, stats, and data views are
all unchanged — this is purely new plumbing underneath them.

---

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** → follow the
   wizard (Google Analytics is optional, you can turn it off).
2. Once created, click the **Web** icon (`</>`) to register a web app.
   Give it any nickname. You do **not** need Firebase Hosting for this step.
3. Firebase will show you a config object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef123456"
   };
   ```

### Where to paste it

Open **`firebase.js`** and paste your values into the `firebaseConfig` object
near the top of the file (it's clearly marked):

```js
const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY_HERE",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};
```

This file is loaded as an ES module (`<script type="module" src="script.js">`
in `index.html`, which itself does `import ... from "./firebase.js"`), so
just editing this one file is enough — nothing else references your config.

> Firebase web config values are not secret; they identify your project,
> they don't authorize access on their own. Real protection comes from the
> Firestore Security Rules in step 3.

---

## 2. Turn on Authentication + Firestore

1. In the Firebase Console sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**. (Students never see
   an email field — the app generates a hidden `stu100001@study.local`
   address internally and signs in with that behind the scenes.)
3. In the sidebar: **Build → Firestore Database → Create database**.
   - Choose a location close to your users.
   - Start in **production mode** (we'll paste real rules in step 3 anyway).

### Do I need to manually create collections?

No. Firestore creates collections/documents automatically the first time
the app writes to them. The first student who registers will automatically
create:

- `students/{their-uid}` — their profile + live activity fields
- `usernames/{their-student-id}` — the lookup used for logging back in
- `counters/students` — the counter that hands out `STU100001`, `STU100002`, ...

You don't need to create anything by hand in the Firestore console.

---

## 3. Set the Security Rules

In the Firebase Console: **Firestore Database → Rules**, replace the
contents with what's in **`firestore.rules`** (included in this project),
then click **Publish**.

Short version of what it does:

| Collection | Read | Write |
|---|---|---|
| `students/{uid}` | anyone (needed for the Admin Dashboard) | only that student, only their own doc |
| `usernames/{studentId}` | anyone (needed so login-by-Student-ID works) | only once, by the account it belongs to |
| `counters/students` | anyone | anyone, but only allowed to *increase* the `count` field |

**Trade-off to know about:** since the Admin Dashboard isn't a real Firebase
account (the "Admin" button just checks a plain-text password in the
browser), Firestore rules can't tell "the admin" apart from anyone else —
so `students` has to be publicly readable (and, for the Delete button,
publicly deletable) for the dashboard to work at all. The `admin4321`
password only gates the *Admin Dashboard button in the UI*; it doesn't
cryptographically lock the database. For a school-project / small-group
tool this is a normal and common trade-off.

### Locking the Admin Dashboard down further

If this ever needs to protect real, sensitive student data (not just a
personal/classroom tool), the standard fix is:

1. Create one real Firebase Auth account for yourself (the admin).
2. Use a Cloud Function (Admin SDK) to set a custom claim on it, e.g.
   `{ role: "admin" }`.
3. Change the security rules to `allow read, delete: if request.auth != null
   && request.auth.token.role == "admin";` on `students` and `usernames`.
4. Change the Admin button to a real sign-in (email+password for you only)
   instead of the plain-text `admin4321` check.

This is more setup (it needs Cloud Functions, which needs the Blaze
pay-as-you-go plan), so it's left out of this build by default — the
current version favors "works immediately, no billing account needed."

---

## Deleting a student (Admin Dashboard)

Every row in the Admin Dashboard's student table has a **Delete** button.
Clicking it asks for confirmation, then:

- Removes their `students/{uid}` profile (they disappear from the dashboard)
- Removes their `usernames/{studentId}` lookup doc (their Student ID +
  password immediately stop being able to log in)

Their underlying Firebase Authentication account technically still exists
(the client SDK can only delete the *currently signed-in* user's own
account, not someone else's — deleting that too would need a Cloud
Function). In practice this doesn't matter: without the lookup doc, their
old Student ID can no longer find its way to that account, so they can't
get back in.

---

## Focus Sound (ambient background sound)

The Focus Timer tab now has a **Focus Sound** panel with:

- A dropdown: **None**, **Soft Rain**, **Brown Noise**, **Deep Focus Drone**
- A **volume slider**
- A **Mute** button (remembers the previous volume so un-muting restores it)

All three sounds are generated live in the browser with the Web Audio API
(filtered noise / simple tones) — there are no audio files involved, so
there's nothing to license and nothing that needs internet access to load.
The sound automatically starts when a focus session is running and stops
during breaks or when the timer is paused/reset. The choice and volume are
remembered per student (saved locally, same as their theme/font settings).

---

## 4. Run it locally

Because `firebase.js` uses ES module imports, opening `index.html` directly
with `file://` won't work (browsers block module imports from the local
filesystem). Serve the folder instead:

```bash
# any of these work
npx serve .
# or
python3 -m http.server 5500
```

Then visit `http://localhost:5500` (or whatever port it prints).

---

## 5. Deploy on GitHub + Vercel

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Study planner with Firebase auth + admin dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

2. **Import into Vercel**
   - Go to <https://vercel.com/new>, choose **Import Git Repository**, pick
     your repo.
   - Framework preset: **Other** (it's plain static HTML/CSS/JS — no build
     step needed).
   - Leave Build Command empty and Output Directory as `.` / root.
   - Click **Deploy**.

3. **Authorize the domain in Firebase**
   Vercel gives you a URL like `your-app.vercel.app`. Firebase Auth only
   allows sign-ins from domains you've approved:
   - Firebase Console → **Authentication → Settings → Authorized domains**
     → **Add domain** → paste your Vercel URL (and your custom domain too,
     if you add one later).

That's it — no server, no build pipeline, no environment variables needed
(the Firebase config is a public client config, safe to commit).

---

## What syncs to Firestore, and when

Every student's `students/{uid}` document is kept up to date automatically:

| Trigger | What updates |
|---|---|
| Website opens (already logged in) | `status`, `lastSeen`, `lastActiveTime` |
| Website closes | `status: "offline"` (best-effort — see note below) |
| Timer starts / resumes | `status: "studying"`, `currentTimer` |
| Timer paused | `status: "online"`, `currentTimer` |
| Timer ends (a focus session completes) | `todayStudyTime`, `weeklyStudyTime`, `monthlyStudyTime`, `totalStudyHours`, `studyStreak` |
| Task completed | `completedTasks` |
| 5 minutes with no mouse/keyboard/touch/scroll activity | `status: "idle"` |
| Activity resumes after being idle | `status: "studying"` or `"online"` |
| Tab hidden / visible | treated as offline / re-evaluated on return |
| Every 20 seconds while logged in | a full refresh (keeps `lastSeen` and the live timer fresh without writing on every single tick) |

**Note on "website closes":** browsers can kill a tab before a final network
request finishes, so a clean "offline" signal on close isn't 100% guaranteed
by any client-only app (this is a real browser limitation, not specific to
this code). To compensate, the Admin Dashboard treats any student whose
`lastSeen` is more than 45 seconds old as **Offline**, regardless of what
status is stored — so a closed tab always shows correctly within ~45s even
if the clean signal was missed.

---

## Admin Dashboard

- Small **Admin** button, fixed top-right, on every screen (including the
  login screen).
- Click it → password prompt → `admin4321` (change this in `script.js`,
  search for `ADMIN_PASSWORD`).
- Shows totals (Total / Online / Offline / Idle / Studying), a searchable,
  filterable, sortable table of every student, and updates **live** via a
  Firestore real-time listener (`onSnapshot`) — actually faster than a
  5-second poll, and still fully "auto-refreshing without reloading."

---

## Files in this project

| File | Purpose |
|---|---|
| `index.html` | Same UI as before, plus the auth screen, registration-success modal, and admin dashboard markup |
| `style.css` | Same design system as before, plus styles for the new screens/modals |
| `script.js` | Same app logic as before (tasks, timer, calendar, stats, data), now gated behind login and wired to sync activity to Firestore |
| `firebase.js` | All Firebase Auth + Firestore code lives here — config, registration, login, activity sync, admin listener |
| `firestore.rules` | Paste into Firebase Console → Firestore → Rules |

// =============================================================================
// firebase.js
// -----------------------------------------------------------------------------
// All Firebase logic for the Study Planner lives in this one file:
//   - Firebase Authentication (Student ID + Password, no email ever shown)
//   - Firestore reads/writes for student profiles and live activity tracking
//   - A real-time listener used by the Admin Dashboard
//
// Uses the Firebase Modular SDK v10, loaded straight from Google's CDN as
// native ES modules — no npm install / bundler required for this project.
// script.js imports everything it needs from here with:
//   import { ... } from "./firebase.js";
// =============================================================================

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  onSnapshot,
  collection,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =============================================================================
   1) PASTE YOUR FIREBASE CONFIG HERE
   -----------------------------------------------------------------------------
   Firebase Console -> (gear icon) Project settings -> General tab ->
   "Your apps" -> select the Web app (</>) -> "SDK setup and configuration" ->
   "Config". Copy the object Firebase gives you and paste its values below.
============================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyBT5mAHzDbx58PMR5dJtObOUyt_2tPdzeg",
  authDomain: "contency-checker.firebaseapp.com",
  projectId: "contency-checker",
  storageBucket: "contency-checker.firebasestorage.app",
  messagingSenderId: "555639281838",
  appId: "1:555639281838:web:738690a659574455aef53f"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/* =============================================================================
   DEVICE ID
   A lightweight identifier for "which browser/device" a student is using.
   Generated once and cached in localStorage — not tied to any real identity.
============================================================================= */
const DEVICE_ID_KEY = "study_planner_device_id";

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = "DEV-" + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/* =============================================================================
   STUDENT ID GENERATION
   -----------------------------------------------------------------------------
   A single counter document (counters/students) is incremented inside a
   Firestore transaction so IDs come out sequential and collision-free:
   STU100001, STU100002, STU100003 ...

   NOTE ON SECURITY (see firestore.rules / README): this counter has to be
   writable *before* the student has a Firebase Auth account yet (we need the
   ID first, to build their hidden email). The security rules therefore allow
   writes to this one specific document, but only to increase the "count"
   field by a valid integer — nothing else in the database is exposed by
   this. If you want to remove even that narrow allowance later, swap this
   function for a random-ID-plus-uniqueness-check strategy (no pre-auth
   write needed at all) — see the README for the drop-in replacement.
============================================================================= */
async function nextStudentId() {
  const counterRef = doc(db, "counters", "students");
  const newCount = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? snap.data().count : 100000;
    const next = current + 1;
    tx.set(counterRef, { count: next }, { merge: true });
    return next;
  });
  return `STU${newCount}`;
}

/* =============================================================================
   REGISTRATION
   -----------------------------------------------------------------------------
   Student only ever types a Name + Password. Internally we:
     1. Generate a sequential Student ID
     2. Build a hidden internal email (STU100001@study.local)
     3. Create the Firebase Auth account with that hidden email
     4. Write the student's Firestore profile
     5. Write a public "usernames" lookup doc (Student ID -> hidden email)
        so a future login-by-Student-ID can find the right account.
   Returns { studentId, uid, name } for the "write this down" popup.
============================================================================= */
export async function registerStudent(name, password) {
  const cleanName = name.trim();
  const studentId = await nextStudentId();
  const email = `${studentId.toLowerCase()}@study.local`; // never shown to the student

  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const uid = credential.user.uid;
  const deviceId = getDeviceId();

  const profile = {
    name: cleanName,
    studentId,
    uid,
    deviceId,
    registrationDate: serverTimestamp(),
    createdTime: serverTimestamp(),
    status: "online",
    currentTimer: "00:00",
    todayStudyTime: 0,
    weeklyStudyTime: 0,
    monthlyStudyTime: 0,
    totalStudyHours: 0,
    studyStreak: 0,
    completedTasks: 0,
    lastActiveTime: serverTimestamp(),
    lastLogin: serverTimestamp(),
    lastSeen: serverTimestamp()
  };

  await setDoc(doc(db, "students", uid), profile);
  await setDoc(doc(db, "usernames", studentId), { uid, email });

  return { studentId, uid, name: cleanName };
}

/* =============================================================================
   LOGIN
   -----------------------------------------------------------------------------
   Student types Student ID + Password only. We look up the hidden email from
   the public "usernames" collection, then sign in with it behind the scenes.
============================================================================= */
export async function loginStudent(studentId, password) {
  const cleanId = studentId.trim().toUpperCase();
  const lookupSnap = await getDoc(doc(db, "usernames", cleanId));
  if (!lookupSnap.exists()) {
    throw new Error("We couldn't find that Student ID.");
  }
  const { email } = lookupSnap.data();

  const credential = await signInWithEmailAndPassword(auth, email, password);
  const uid = credential.user.uid;

  await updateDoc(doc(db, "students", uid), {
    status: "online",
    deviceId: getDeviceId(),
    lastLogin: serverTimestamp(),
    lastSeen: serverTimestamp(),
    lastActiveTime: serverTimestamp()
  });

  const profileSnap = await getDoc(doc(db, "students", uid));
  return { uid, ...profileSnap.data() };
}

export function logoutStudent() {
  return signOut(auth);
}

/** Fires immediately with the current user (or null), then on every change. */
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

/** Reads a student's Firestore profile (used right after onAuthStateChanged fires). */
export async function getStudentProfile(uid) {
  const snap = await getDoc(doc(db, "students", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/* =============================================================================
   ACTIVITY SYNC
   -----------------------------------------------------------------------------
   One reusable function for every sync point requested: app opened/closed,
   timer start/pause/resume/end, task completed, study hours changed, idle/
   active. Callers only ever pass the fields that actually changed; lastSeen
   (and lastActiveTime, unless explicitly overridden) are stamped here so
   every call point doesn't need to repeat that logic.
============================================================================= */
export function updateStudentActivity(uid, fields) {
  if (!uid) return Promise.resolve();
  return updateDoc(doc(db, "students", uid), {
    lastActiveTime: serverTimestamp(),
    lastSeen: serverTimestamp(),
    ...fields
  }).catch((err) => {
    // Never let a flaky connection or a closing tab break the app UI.
    console.warn("Activity sync failed:", err.message);
  });
}

/* =============================================================================
   ADMIN DASHBOARD — real-time student list
   -----------------------------------------------------------------------------
   onSnapshot streams changes the instant they happen (faster and cheaper
   than re-polling every 5 seconds), so the Admin Dashboard updates live
   without ever reloading the page.
============================================================================= */
export function watchAllStudents(callback) {
  return onSnapshot(
    collection(db, "students"),
    (snap) => {
      const students = [];
      snap.forEach((d) => students.push({ uid: d.id, ...d.data() }));
      callback(students);
    },
    (error) => console.warn("Admin listener error:", error.message)
  );
}

/* =============================================================================
   ADMIN — delete a student
   -----------------------------------------------------------------------------
   Removes their Firestore profile (students/{uid}) and their login lookup
   (usernames/{studentId}), so their Student ID immediately stops working for
   login and they disappear from the Admin Dashboard.

   NOTE: this does NOT delete their underlying Firebase Authentication
   account — the client SDK is only allowed to delete the currently signed-in
   user's own account, not an arbitrary other user's. Deleting the Auth
   account too would require a Cloud Function with the Admin SDK. In
   practice this doesn't matter for day-to-day use: once the lookup doc is
   gone, "loginStudent()" can no longer find their hidden email, so their
   old Student ID + password can't get back in.
============================================================================= */
export async function deleteStudentRecord(uid, studentId) {
  await deleteDoc(doc(db, "students", uid));
  if (studentId) {
    await deleteDoc(doc(db, "usernames", studentId));
  }
}

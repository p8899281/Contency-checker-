// =============================================================================
// firebase.js
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
   1) FIREBASE CONFIG
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
============================================================================= */
export async function registerStudent(name, password) {
  const cleanName = name.trim();
  const studentId = await nextStudentId();
  const email = `${studentId.toLowerCase()}@study.local`;

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

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function getStudentProfile(uid) {
  const snap = await getDoc(doc(db, "students", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/* =============================================================================
   ACTIVITY SYNC
============================================================================= */
export function updateStudentActivity(uid, fields) {
  if (!uid) return Promise.resolve();
  return updateDoc(doc(db, "students", uid), {
    lastActiveTime: serverTimestamp(),
    lastSeen: serverTimestamp(),
    ...fields
  }).catch((err) => {
    console.warn("Activity sync failed:", err.message);
  });
}

/* =============================================================================
   ADMIN DASHBOARD — real-time student list
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

export async function deleteStudentRecord(uid, studentId) {
  await deleteDoc(doc(db, "students", uid));
  if (studentId) {
    await deleteDoc(doc(db, "usernames", studentId));
  }
}

/* =============================================================================
   ADMIN FOCUS SOUND MANAGEMENT (FIRESTORE)
============================================================================= */
export function watchCustomSounds(callback) {
  return onSnapshot(
    collection(db, "focus_sounds"),
    (snap) => {
      const sounds = [];
      snap.forEach((d) => sounds.push({ id: d.id, ...d.data() }));
      callback(sounds);
    },
    (error) => console.warn("Sound listener error:", error.message)
  );
}

export async function addCustomSoundRecord(title, audioUrl) {
  const docRef = doc(collection(db, "focus_sounds"));
  await setDoc(docRef, {
    title: title.trim(),
    audioUrl: audioUrl.trim(),
    createdAt: serverTimestamp()
  });
}

export async function deleteCustomSoundRecord(id) {
  await deleteDoc(doc(db, "focus_sounds", id));
}

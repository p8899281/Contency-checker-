/* constancy checker by soumen */

import {
  watchAuthState,
  getStudentProfile,
  registerStudent,
  loginStudent,
  logoutStudent,
  updateStudentActivity,
  watchAllStudents,
  deleteStudentRecord,
  watchCustomSounds,
  addCustomSoundRecord,
  deleteCustomSoundRecord
} from "./firebase.js";

const STORAGE_BASE = "constancy_checker_by_soumen_v1";
const SETTINGS_BASE = "constancy_checker_by_soumen_settings_v1";

function storageKey(){ return `${STORAGE_BASE}_${currentStudent ? currentStudent.uid : "guest"}`; }
function settingsKey(){ return `${SETTINGS_BASE}_${currentStudent ? currentStudent.uid : "guest"}`; }

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function localDateKey(date){
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
const todayISO = () => localDateKey(new Date());

const state = {
  tasks: [],
  focusSessions: [],
  calendar: {},
  settings: { theme: "dark", fontSize: 16 },
  timer: {
    mode: "focus",
    workMinutes: 25,
    breakMinutes: 5,
    remaining: 25 * 60,
    running: false,
    interval: null,
    phase: "focus",
    selectedMode: "focus",
    endAt: null
  },
  selectedDate: todayISO(),
  currentMonth: new Date().getMonth(),
  currentYear: new Date().getFullYear(),
  focusSound: { kind: "none", volume: 0.4 },
  customSounds: []
};

let wakeLockSentinel = null;
let alarmInterval = null;
let alarmAudioCtx = null;
let currentStudent = null;

function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(storageKey()));
    if(saved){
      Object.assign(state, saved);
      state.timer = Object.assign(
        { mode:"focus", workMinutes:25, breakMinutes:5, remaining:1500, running:false, interval:null, phase:"focus", selectedMode:"focus", endAt:null },
        saved.timer || {}
      );
      state.focusSound = Object.assign({ kind:"none", volume:0.4 }, saved.focusSound || {});
    }
    const settings = JSON.parse(localStorage.getItem(settingsKey()));
    if(settings) state.settings = Object.assign(state.settings, settings);
  }catch(e){}
}

function saveState(){
  const persist = {
    tasks: state.tasks,
    focusSessions: state.focusSessions,
    calendar: state.calendar,
    timer: {
      mode: state.timer.mode,
      workMinutes: state.timer.workMinutes,
      breakMinutes: state.timer.breakMinutes,
      remaining: state.timer.remaining,
      running: state.timer.running,
      phase: state.timer.phase,
      selectedMode: state.timer.selectedMode,
      endAt: state.timer.endAt
    },
    selectedDate: state.selectedDate,
    currentMonth: state.currentMonth,
    currentYear: state.currentYear,
    focusSound: state.focusSound
  };
  localStorage.setItem(storageKey(), JSON.stringify(persist));
  localStorage.setItem(settingsKey(), JSON.stringify(state.settings));
}

function autosave(){ saveState(); renderAll(); syncActivityIfChanged(); }

function formatMinutes(mins){
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function formatTime(sec){
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function startOfWeek(d){
  const date = new Date(d);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return new Date(date.setHours(0,0,0,0));
}

function dateKey(date){ return localDateKey(date); }
function monthName(y,m){ return new Date(y,m,1).toLocaleDateString(undefined,{month:"long", year:"numeric"}); }
function getGreeting(){
  const h = new Date().getHours();
  return h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening";
}

function taskStats(){
  const today = todayISO();
  const todaysTasks = state.tasks.filter(t => t.createdAt === today);
  const completed = todaysTasks.filter(t => t.done).length;
  return {
    totalToday: todaysTasks.length,
    pending: todaysTasks.filter(t => !t.done).length,
    completed,
    completionPercent: todaysTasks.length ? Math.round((completed / todaysTasks.length) * 100) : 0
  };
}

function studyMinutesForRange(start, end){
  return state.focusSessions.reduce((sum,s)=>{
    const d = new Date(s.date);
    if(d >= start && d <= end) return sum + (s.minutes || 0);
    return sum;
  }, 0);
}

function renderClock(){
  $("#greeting").textContent = getGreeting();
  $("#todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  $("#currentTime").textContent = new Date().toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function renderStats(){
  const today = todayISO();
  const now = new Date();
  const weekStart = startOfWeek(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayMinutes = studyMinutesForRange(new Date(today+"T00:00:00"), new Date(today+"T23:59:59"));
  const weekMinutes = studyMinutesForRange(weekStart, now);
  const monthMinutes = studyMinutesForRange(monthStart, now);
  const allDays = [...new Set(state.focusSessions.map(s => s.date))].length || 1;
  const avg = Math.round(monthMinutes / allDays);

  const completedTasks = state.tasks.filter(t => t.done).length;
  const streak = calculateStreak();

  const st = taskStats();
  $("#todayTasksCount").textContent = st.totalToday;
  $("#pendingTasksCount").textContent = st.pending;
  $("#completedTasksCount").textContent = st.completed;
  $("#todayStudyHours").textContent = formatMinutes(todayMinutes);
  $("#completionPercent").textContent = `${st.completionPercent}%`;

  $("#sidebarStreak").textContent = `${streak} days`;
  $("#sidebarTodayHours").textContent = formatMinutes(todayMinutes);

  $("#dashTodayTasks").textContent = st.totalToday;
  $("#dashPendingTasks").textContent = st.pending;
  $("#dashCompletedTasks").textContent = st.completed;
  $("#dashTodayHours").textContent = formatMinutes(todayMinutes);
  $("#dashStreak").textContent = `${streak} days`;
  $("#dashWeeklyProgress").textContent = `${Math.min(100, Math.round((weekMinutes / (7*60)) * 100))}%`;
  $("#dashMonthlyProgress").textContent = `${Math.min(100, Math.round((monthMinutes / (30*60)) * 100))}%`;

  $("#statsToday").textContent = formatMinutes(todayMinutes);
  $("#statsWeekly").textContent = formatMinutes(weekMinutes);
  $("#statsMonthly").textContent = formatMinutes(monthMinutes);
  $("#statsStreak").textContent = `${streak} days`;
  $("#statsCompleted").textContent = completedTasks;
  $("#statsAverage").textContent = formatMinutes(avg);

  const circle = $("#progressCircle");
  const percent = st.completionPercent;
  const dash = 314 - (314 * percent / 100);
  circle.style.strokeDashoffset = dash;
}

function calculateStreak(){
  const doneDays = [...new Set(state.focusSessions.map(s => s.date))].sort();
  if(!doneDays.length) return 0;
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0,0,0,0);
  while(true){
    const key = dateKey(cursor);
    if(doneDays.includes(key)){ streak++; cursor.setDate(cursor.getDate()-1); }
    else break;
  }
  return streak;
}

function renderTasks(){
  const list = $("#taskList");
  list.innerHTML = "";
  const today = todayISO();

  state.tasks
    .filter(t => t.createdAt === today)
    .sort((a,b)=> (a.done - b.done) || ({High:0,Medium:1,Low:2}[a.priority]-{High:0,Medium:1,Low:2}[b.priority]))
    .forEach(task => {
      const el = document.createElement("div");
      el.className = `task-item ${task.done ? "done" : ""}`;
      el.innerHTML = `
        <div>
          <strong>${escapeHtml(task.title)}</strong>
          <div class="muted">${escapeHtml(task.subject)} · ${task.priority}</div>
        </div>
        <div class="task-actions">
          <button class="btn ghost" data-action="toggle" data-id="${task.id}">${task.done ? "Undo" : "Complete"}</button>
          <button class="btn secondary" data-action="edit" data-id="${task.id}">Edit</button>
          <button class="btn danger" data-action="delete" data-id="${task.id}">Delete</button>
        </div>`;
      list.appendChild(el);
    });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
}

function renderCalendar(){
  const grid = $("#calendarGrid");
  grid.innerHTML = "";
  const first = new Date(state.currentYear, state.currentMonth, 1);
  const last = new Date(state.currentYear, state.currentMonth + 1, 0);
  const startDay = (first.getDay() + 6) % 7;
  $("#calendarMonthLabel").textContent = monthName(state.currentYear, state.currentMonth);

  const weekdays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  weekdays.forEach(d => {
    const hd = document.createElement("div");
    hd.className = "day-cell muted";
    hd.style.minHeight = "42px";
    hd.innerHTML = `<div class="day-num">${d}</div>`;
    grid.appendChild(hd);
  });

  for(let i=0;i<startDay;i++){
    const blank = document.createElement("div");
    blank.className = "day-cell muted";
    grid.appendChild(blank);
  }

  for(let day=1; day<=last.getDate(); day++){
    const iso = dateKey(new Date(state.currentYear, state.currentMonth, day));
    const focusMins = state.focusSessions.filter(s => s.date === iso).reduce((a,b)=>a+b.minutes,0);
    const tasks = state.tasks.filter(t => t.createdAt === iso).length;
    const cell = document.createElement("div");
    cell.className = `day-cell ${iso === state.selectedDate ? "selected" : ""}`;
    cell.innerHTML = `<div class="day-num">${day}</div><div class="day-meta">${formatMinutes(focusMins)} · ${tasks} tasks</div>`;
    cell.onclick = () => {
      state.selectedDate = iso;
      autosave();
      updateCalendarDetails();
      renderCalendar();
    };
    grid.appendChild(cell);
  }
  updateCalendarDetails();
}

function updateCalendarDetails(){
  $("#selectedDateLabel").textContent = state.selectedDate;
  const entry = state.calendar[state.selectedDate] || {};
  $("#calendarStudyHours").value = entry.studyHours ?? "";
  $("#calendarNotes").value = entry.notes ?? "";
  const taskCount = state.tasks.filter(t => t.createdAt === state.selectedDate).length;
  const focusMins = state.focusSessions.filter(s => s.date === state.selectedDate).reduce((a,b)=>a+b.minutes,0);
  $("#daySummary").textContent = `${taskCount} tasks · ${formatMinutes(focusMins)} studied`;
}

function renderSettings(){
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.style.setProperty("--base-font", `${state.settings.fontSize}px`);
  $(`input[name="theme"][value="${state.settings.theme}"]`).checked = true;
  $("#fontSize").value = state.settings.fontSize;
}

function renderTimer(){
  $("#timerDisplay").textContent = formatTime(state.timer.remaining);
  $("#timerMode").textContent = state.timer.phase === "focus" ? "Focus" : "Break";
  
  const focusBtn = $("#switchToFocusBtn");
  const breakBtn = $("#switchToBreakBtn");
  const input = $("#customMinutes");

  const activeViewMode = state.timer.selectedMode || state.timer.phase;

  if(focusBtn && breakBtn){
    if(activeViewMode === "focus"){
      focusBtn.className = "btn primary";
      breakBtn.className = "btn secondary";
      if(input) input.placeholder = `Focus minutes (e.g. ${state.timer.workMinutes})`;
    }else{
      focusBtn.className = "btn secondary";
      breakBtn.className = "btn primary";
      if(input) input.placeholder = `Break minutes (e.g. ${state.timer.breakMinutes})`;
    }
  }

  updateMediaSessionMetadata();
}

function renderTimerActiveState(){
  const circle = $("#timerCircle");
  if(circle) circle.classList.toggle("is-running", !!state.timer.running);
}

function renderChart(){
  const canvas = $("#progressChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const days = Array.from({length:7}, (_,i)=>{
    const d = new Date();
    d.setDate(d.getDate() - (6-i));
    d.setHours(0,0,0,0);
    return d;
  });

  const values = days.map(d => studyMinutesForRange(d, new Date(d.getTime() + 86399999)) / 60);
  const max = Math.max(1, ...values);
  const barW = 90;
  const gap = 35;
  const startX = 35;

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
  ctx.font = "14px 'JetBrains Mono', monospace";
  ctx.fillText("Last 7 days", 18, 24);

  values.forEach((v,i)=>{
    const x = startX + i*(barW+gap);
    const barH = (v/max) * 165;
    ctx.fillStyle = "rgba(232,163,61,.8)";
    roundRect(ctx, x, 220-barH, barW, barH, 16, true, false);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text");
    ctx.fillText(days[i].toLocaleDateString(undefined,{weekday:"short"}), x+18, 242);
    ctx.fillText(v.toFixed(1)+"h", x+18, 205-barH);
  });
}

function renderMonthlyTrendChart(){
  const canvas = $("#monthlyTrendChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const days = Array.from({length:30}, (_,i)=>{
    const d = new Date();
    d.setDate(d.getDate() - (29-i));
    d.setHours(0,0,0,0);
    return d;
  });
  const values = days.map(d => studyMinutesForRange(d, new Date(d.getTime()+86399999))/60);
  const max = Math.max(1, ...values);
  const padding = 30;
  const plotW = w - padding*2;
  const plotH = h - padding*2;
  const stepX = values.length > 1 ? plotW/(values.length-1) : 0;

  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--line");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, h-padding);
  ctx.lineTo(w-padding, h-padding);
  ctx.stroke();

  ctx.beginPath();
  values.forEach((v,i)=>{
    const x = padding + i*stepX;
    const y = h - padding - (v/max)*plotH;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.strokeStyle = "#e8a33d";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(padding+plotW, h-padding);
  ctx.lineTo(padding, h-padding);
  ctx.closePath();
  ctx.fillStyle = "rgba(232,163,61,.15)";
  ctx.fill();

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
  ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.fillText(days[0].toLocaleDateString(undefined,{month:"short",day:"numeric"}), padding, h-8);
  const lastLabel = days[days.length-1].toLocaleDateString(undefined,{month:"short",day:"numeric"});
  ctx.fillText(lastLabel, w-padding-ctx.measureText(lastLabel).width, h-8);
}

function renderTaskCompletionChart(){
  const canvas = $("#taskCompletionChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const total = state.tasks.length;
  const completed = state.tasks.filter(t=>t.done).length;
  const pending = total - completed;
  const cx = w/2, cy = h/2, r = Math.min(w,h)/2 - 18;

  const legend = $("#taskCompletionLegend");

  if(total === 0){
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.font = "14px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No tasks yet", cx, cy);
    ctx.textAlign = "start";
    if(legend) legend.innerHTML = `<p class="empty-note">Add a task to see this chart.</p>`;
    return;
  }

  const completedAngle = (completed/total) * Math.PI*2;
  ctx.lineWidth = 26;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(cx,cy,r, -Math.PI/2 + completedAngle, Math.PI*1.5);
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.stroke();

  if(completed > 0){
    ctx.beginPath();
    ctx.arc(cx,cy,r, -Math.PI/2, -Math.PI/2 + completedAngle);
    ctx.strokeStyle = "#4f9d69";
    ctx.stroke();
  }

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text");
  ctx.font = "700 22px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round((completed/total)*100)}%`, cx, cy+8);
  ctx.textAlign = "start";

  if(legend){
    legend.innerHTML = `
      <div class="legend-row"><span class="swatch" style="background:#4f9d69"></span>Completed · ${completed}</div>
      <div class="legend-row"><span class="swatch" style="background:rgba(255,255,255,.25)"></span>Pending · ${pending}</div>
    `;
  }
}

function renderTable(headers, rows){
  return `<table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderDataTables(){
  const tasksSorted = [...state.tasks].sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
  $("#dataTaskCount").textContent = tasksSorted.length;
  $("#allTasksTable").innerHTML = tasksSorted.length
    ? renderTable(
        ["Date","Title","Subject","Priority","Status"],
        tasksSorted.map(t=>[t.createdAt, escapeHtml(t.title), escapeHtml(t.subject), t.priority, t.done ? "Done" : "Pending"])
      )
    : `<p class="empty-note">No tasks logged yet.</p>`;

  const sessionsSorted = [...state.focusSessions].sort((a,b)=> (b.timestamp||0) - (a.timestamp||0));
  $("#dataSessionCount").textContent = sessionsSorted.length;
  $("#allSessionsTable").innerHTML = sessionsSorted.length
    ? renderTable(
        ["Date","Time","Duration"],
        sessionsSorted.map(s=>[
          s.date,
          s.timestamp ? new Date(s.timestamp).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"}) : "—",
          formatMinutes(s.minutes || 0)
        ])
      )
    : `<p class="empty-note">No focus sessions logged yet.</p>`;

  const calendarEntries = Object.entries(state.calendar).sort((a,b)=> b[0].localeCompare(a[0]));
  $("#dataCalendarCount").textContent = calendarEntries.length;
  $("#allCalendarTable").innerHTML = calendarEntries.length
    ? renderTable(
        ["Date","Hours","Notes"],
        calendarEntries.map(([date,entry])=>[date, entry.studyHours ?? 0, escapeHtml(entry.notes || "—")])
      )
    : `<p class="empty-note">No calendar entries yet.</p>`;
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof radius === "number") radius = {tl: radius, tr: radius, br: radius, bl: radius};
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function renderAll(){
  renderClock();
  renderStats();
  renderTasks();
  renderCalendar();
  renderSettings();
  renderTimer();
  renderTimerActiveState();
  renderFocusSoundUI();
  renderChart();
  renderDataTables();
  renderMonthlyTrendChart();
  renderTaskCompletionChart();
}

function switchView(view){
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.remove("view-active"));
  $("#view-" + view).classList.add("view-active");
}

function notify(title, body){
  if("Notification" in window && Notification.permission === "granted"){
    new Notification(title, { body });
  }
}

/* =============================================================================
   PURE MP3 FOCUS SOUND & MEDIA SESSION CONTROLS
============================================================================= */
let activeCustomAudio = null;
let focusSoundVolumeBeforeMute = 0.4;
let focusSoundPlayingKind = null;
let userPausedSound = false;

function getAllSoundKinds() {
  return (state.customSounds || []).map(s => s.id);
}

function switchSoundTrack(direction) {
  const kinds = getAllSoundKinds();
  if (kinds.length === 0) return;
  let currentIndex = kinds.indexOf(state.focusSound.kind);
  if (currentIndex === -1) currentIndex = 0;

  let newIndex = (currentIndex + direction + kinds.length) % kinds.length;
  const newKind = kinds[newIndex];

  userPausedSound = false;
  state.focusSound.kind = newKind;
  renderFocusSoundUI();
  startFocusSound(newKind);
  autosave();
}

function updateMediaSessionMetadata(){
  if ('mediaSession' in navigator && state.timer.running && activeCustomAudio) {
    const custom = state.customSounds.find(s => s.id === state.focusSound.kind || s.title === state.focusSound.kind);
    const soundTitle = custom ? custom.title : "Focus Sound";

    navigator.mediaSession.metadata = new MediaMetadata({
      title: `⏱️ ${formatTime(state.timer.remaining)} (${state.timer.phase.toUpperCase()}) · ${soundTitle}`,
      artist: 'Study with Nishtha · Ekagra',
      album: 'Constancy Checker by Soumen'
    });

    navigator.mediaSession.playbackState = userPausedSound ? 'paused' : 'playing';

    navigator.mediaSession.setActionHandler('play', () => {
      userPausedSound = false;
      if (activeCustomAudio) activeCustomAudio.play().catch(()=>{});
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      updateFocusSoundForTimerState();
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      userPausedSound = true;
      if (activeCustomAudio) activeCustomAudio.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => switchSoundTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => switchSoundTrack(1));
  }
}

function stopFocusSound(){
  if(activeCustomAudio){
    try{ activeCustomAudio.pause(); activeCustomAudio.currentTime = 0; }catch(e){}
    activeCustomAudio = null;
  }
  focusSoundPlayingKind = null;
}

function startFocusSound(kind){
  stopFocusSound();
  if(kind === "none") return;

  const customSound = state.customSounds.find(s => s.id === kind || s.title === kind);
  if(customSound && customSound.audioUrl){
    try {
      activeCustomAudio = new Audio(customSound.audioUrl);
      activeCustomAudio.loop = true;
      activeCustomAudio.volume = state.focusSound.volume;
      
      // 👈 অন্য অ্যাপ অডিও ইন্টারাপ্ট (যেমন ইউটিউব চালু) করলে ফোকাস ইয়েল্ড করবে
      activeCustomAudio.addEventListener('pause', () => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      });

      activeCustomAudio.play().then(() => {
        focusSoundPlayingKind = kind;
        updateMediaSessionMetadata();
      }).catch(e => {
        console.warn("Audio play failed:", e.message);
        focusSoundPlayingKind = null;
      });
    } catch(e) {
      console.warn("Audio init failed:", e.message);
      focusSoundPlayingKind = null;
    }
  }
}

function setFocusSoundVolume(v){
  state.focusSound.volume = v;
  if(activeCustomAudio) activeCustomAudio.volume = v;
}

function updateFocusSoundForTimerState(){
  if (userPausedSound) return;

  const desiredKind = state.focusSound.kind;
  const shouldPlay = state.timer.running && state.timer.phase === "focus" && desiredKind !== "none";

  if(!shouldPlay){
    if(focusSoundPlayingKind !== null) stopFocusSound();
    return;
  }

  if(focusSoundPlayingKind !== desiredKind){
    startFocusSound(desiredKind);
  }
}

function renderFocusSoundUI(){
  const select = $("#focusSoundSelect");
  if(!select) return;

  let html = `<option value="none">None</option>`;

  if(state.customSounds && state.customSounds.length > 0){
    html += `<optgroup label="Admin Focus Sounds">`;
    state.customSounds.forEach(s => {
      html += `<option value="${s.id}">${escapeHtml(s.title)}</option>`;
    });
    html += `</optgroup>`;
  }

  if(select.innerHTML.trim() !== html.trim()){
    const currentVal = state.focusSound.kind;
    select.innerHTML = html;
    select.value = currentVal;
  } else if(select.value !== state.focusSound.kind) {
    select.value = state.focusSound.kind;
  }

  $("#focusSoundVolume").value = Math.round(state.focusSound.volume * 100);
  $("#focusSoundMuteBtn").textContent = state.focusSound.volume > 0 ? "Mute" : "Unmute";
}

/* =============================================================================
   FIRESTORE ACTIVITY SYNC
============================================================================= */
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;

let idleTimer = null;
let isIdle = false;
let lastSyncedSnapshot = "";
let heartbeatInterval = null;

function computeActivityStatus(){
  if(document.hidden) return "offline";
  if(isIdle) return "idle";
  if(state.timer.running) return "studying";
  return "online";
}

function computeActivitySnapshot(){
  const now = new Date();
  const today = todayISO();
  const weekStart = startOfWeek(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayMinutes = studyMinutesForRange(new Date(today+"T00:00:00"), new Date(today+"T23:59:59"));
  const weekMinutes = studyMinutesForRange(weekStart, now);
  const monthMinutes = studyMinutesForRange(monthStart, now);
  const totalMinutes = state.focusSessions.reduce((sum,s)=> sum + (s.minutes||0), 0);

  return {
    name: currentStudent ? currentStudent.name : "",
    studentId: currentStudent ? currentStudent.studentId : "",
    status: computeActivityStatus(),
    currentTimer: formatTime(state.timer.remaining),
    todayStudyTime: todayMinutes,
    weeklyStudyTime: weekMinutes,
    monthlyStudyTime: monthMinutes,
    totalStudyHours: Math.round((totalMinutes/60) * 100) / 100,
    completedTasks: state.tasks.filter(t=>t.done).length,
    studyStreak: calculateStreak()
  };
}

function syncActivityIfChanged(){
  if(!currentStudent) return;
  const snapshot = computeActivitySnapshot();
  const { currentTimer, ...meaningfulFields } = snapshot;
  const key = JSON.stringify(meaningfulFields);
  if(key === lastSyncedSnapshot) return;
  lastSyncedSnapshot = key;
  updateStudentActivity(currentStudent.uid, snapshot);
}

function startHeartbeat(){
  if(heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(()=>{
    if(!currentStudent) return;
    updateStudentActivity(currentStudent.uid, computeActivitySnapshot());
  }, HEARTBEAT_MS);
}
function stopHeartbeat(){
  if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function resetIdleTimer(){
  if(isIdle){
    isIdle = false;
    syncActivityIfChanged();
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(()=>{
    isIdle = true;
    syncActivityIfChanged();
  }, IDLE_LIMIT_MS);
}

function bindIdleDetection(){
  ["mousemove","mousedown","keydown","touchstart","scroll"].forEach(evt=>{
    document.addEventListener(evt, resetIdleTimer, { passive:true });
  });
  resetIdleTimer();

  document.addEventListener("visibilitychange", ()=>{
    syncActivityIfChanged();
    if(!document.hidden) resetIdleTimer();
  });
}

/* ---------- Alarm ---------- */
function playAlarm(){
  stopAlarm();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtx) return;
  alarmAudioCtx = new AudioCtx();
  let count = 0;
  const maxBeeps = 6;

  function beepOnce(){
    if(!alarmAudioCtx) return;
    const o = alarmAudioCtx.createOscillator();
    const g = alarmAudioCtx.createGain();
    o.type = "square";
    o.frequency.value = count % 2 === 0 ? 880 : 660;
    g.gain.value = 0.001;
    g.gain.exponentialRampToValueAtTime(0.22, alarmAudioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, alarmAudioCtx.currentTime + 0.28);
    o.connect(g); g.connect(alarmAudioCtx.destination);
    o.start();
    o.stop(alarmAudioCtx.currentTime + 0.3);
  }

  beepOnce();
  alarmInterval = setInterval(()=>{
    count++;
    if(count >= maxBeeps){ stopAlarm(); return; }
    beepOnce();
  }, 400);

  if(navigator.vibrate) navigator.vibrate([300,150,300,150,300,150,300]);

  const btn = $("#stopAlarm");
  if(btn) btn.hidden = false;
}

function stopAlarm(){
  if(alarmInterval){ clearInterval(alarmInterval); alarmInterval = null; }
  if(alarmAudioCtx){ alarmAudioCtx.close().catch(()=>{}); alarmAudioCtx = null; }
  if(navigator.vibrate) navigator.vibrate(0);
  const btn = $("#stopAlarm");
  if(btn) btn.hidden = true;
}

/* ---------- Screen Wake Lock ---------- */
async function requestWakeLock(){
  try{
    if("wakeLock" in navigator){
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", ()=>{ wakeLockSentinel = null; });
    }
  }catch(e){}
}
function releaseWakeLock(){
  if(wakeLockSentinel){ wakeLockSentinel.release().catch(()=>{}); wakeLockSentinel = null; }
}

/* ---------- Timer ---------- */
function advancePhase(){
  const finishedPhase = state.timer.phase;
  const finishedMinutes = finishedPhase === "focus" ? state.timer.workMinutes : state.timer.breakMinutes;
  
  if(finishedPhase === "focus"){
    state.focusSessions.push({ date: todayISO(), minutes: finishedMinutes, timestamp: Date.now() });
    state.timer.phase = "break";
    state.timer.selectedMode = "break";
    state.timer.remaining = state.timer.breakMinutes * 60;
  }else{
    state.timer.phase = "focus";
    state.timer.selectedMode = "focus";
    state.timer.remaining = state.timer.workMinutes * 60;
  }
  
  state.timer.running = false;
  state.timer.endAt = null;
  releaseWakeLock();
  stopFocusSound();
}

function evaluateTimer(triggerEffects){
  if(!state.timer.running || !state.timer.endAt){
    renderTimer();
    return;
  }
  const now = Date.now();
  let completedAny = false;
  
  if(state.timer.endAt <= now){
    advancePhase();
    completedAny = true;
  }
  
  if(state.timer.running){
    state.timer.remaining = Math.max(0, Math.round((state.timer.endAt - now)/1000));
  }
  
  // 👈 প্রতি ১-সেকেন্ডের অডিও হাইজ্যাক লুপ বন্ধ করা হলো! (যাতে ইউটিউব ক্লাস সুন্দরভাবে প্লে হতে পারে)
  
  if(completedAny && triggerEffects){
    playAlarm();
    notify("Timer Finished", state.timer.phase === "break" ? "Focus session complete! Time for a break." : "Break finished! Ready to focus?");
  }
  renderTimer();
  autosave();
}

function startTimerLoop(){
  if(state.timer.interval) clearInterval(state.timer.interval);
  state.timer.interval = setInterval(()=>{
    if(!state.timer.running) return;
    evaluateTimer(true);
  }, 1000);
}

function bindEvents(){
  $$(".nav-item").forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  // Mode Switchers
  const focusBtn = $("#switchToFocusBtn");
  const breakBtn = $("#switchToBreakBtn");

  if(focusBtn){
    focusBtn.onclick = () => {
      state.timer.selectedMode = "focus";
      if(!state.timer.running){
        stopAlarm();
        userPausedSound = false;
        state.timer.phase = "focus";
        state.timer.endAt = null;
        state.timer.remaining = state.timer.workMinutes * 60;
        releaseWakeLock();
        stopFocusSound();
      }
      renderTimer();
      autosave();
    };
  }

  if(breakBtn){
    breakBtn.onclick = () => {
      state.timer.selectedMode = "break";
      if(!state.timer.running){
        stopAlarm();
        userPausedSound = false;
        state.timer.phase = "break";
        state.timer.endAt = null;
        state.timer.remaining = state.timer.breakMinutes * 60;
        releaseWakeLock();
        stopFocusSound();
      }
      renderTimer();
      autosave();
    };
  }

  $("#taskForm").addEventListener("submit", e => {
    e.preventDefault();
    const id = $("#taskId").value || crypto.randomUUID();
    const task = {
      id,
      title: $("#taskTitle").value.trim(),
      subject: $("#taskSubject").value.trim(),
      priority: $("#taskPriority").value,
      done: false,
      createdAt: todayISO()
    };
    const existing = state.tasks.findIndex(t => t.id === id);
    if(existing >= 0) state.tasks[existing] = { ...state.tasks[existing], ...task };
    else state.tasks.unshift(task);
    e.target.reset();
    $("#taskId").value = "";
    autosave();
    toast("Task saved");
  });

  $("#taskList").addEventListener("click", e => {
    const id = e.target.dataset.id;
    const action = e.target.dataset.action;
    const task = state.tasks.find(t => t.id === id);
    if(!task) return;
    if(action === "toggle"){ task.done = !task.done; autosave(); }
    if(action === "delete"){
      state.tasks = state.tasks.filter(t => t.id !== id);
      autosave();
    }
    if(action === "edit"){
      $("#taskId").value = task.id;
      $("#taskTitle").value = task.title;
      $("#taskSubject").value = task.subject;
      $("#taskPriority").value = task.priority;
      switchView("tasks");
    }
  });

  $$(".preset-btn").forEach(btn => btn.addEventListener("click", ()=>{
    $$(".preset-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    state.timer.workMinutes = Number(btn.dataset.minutes);
    state.timer.breakMinutes = Number(btn.dataset.break);

    const activeViewMode = state.timer.selectedMode || state.timer.phase;
    if(!state.timer.running){
      state.timer.remaining = (activeViewMode === "focus" ? state.timer.workMinutes : state.timer.breakMinutes) * 60;
    }
    autosave();
  }));

  // Single Input Custom Timer Logic
  $("#applyCustomTimer").addEventListener("click", ()=>{
    const activeViewMode = state.timer.selectedMode || state.timer.phase;
    const mins = Number($("#customMinutes").value);
    if(!mins || mins < 1) return;

    if(activeViewMode === "focus"){
      state.timer.workMinutes = mins;
      if(!state.timer.running && state.timer.phase === "focus"){
        state.timer.remaining = mins * 60;
      } else if(state.timer.running && state.timer.phase === "focus"){
        state.timer.remaining = mins * 60;
        state.timer.endAt = Date.now() + state.timer.remaining * 1000;
      }
    }else{
      state.timer.breakMinutes = mins;
      if(!state.timer.running && state.timer.phase === "break"){
        state.timer.remaining = mins * 60;
      } else if(state.timer.running && state.timer.phase === "break"){
        state.timer.remaining = mins * 60;
        state.timer.endAt = Date.now() + state.timer.remaining * 1000;
      }
    }
    
    $("#customMinutes").value = "";
    autosave();
    toast(`${activeViewMode === "focus" ? "Focus" : "Break"} timer applied: ${mins} min`);
  });

  $("#startTimer").onclick = () => {
    stopAlarm();
    userPausedSound = false;

    if(state.timer.selectedMode){
      const modeChanged = state.timer.phase !== state.timer.selectedMode;
      state.timer.phase = state.timer.selectedMode;
      
      if(modeChanged || !state.timer.running){
        state.timer.remaining = (state.timer.phase === "focus" ? state.timer.workMinutes : state.timer.breakMinutes) * 60;
      }
    }

    state.timer.endAt = Date.now() + state.timer.remaining*1000;
    state.timer.running = true;
    startTimerLoop();
    requestWakeLock();
    updateFocusSoundForTimerState();
    autosave();
  };

  $("#pauseTimer").onclick = () => {
    evaluateTimer(false);
    state.timer.running = false;
    state.timer.endAt = null;
    releaseWakeLock();
    updateFocusSoundForTimerState();
    autosave();
  };

  $("#resumeTimer").onclick = () => {
    stopAlarm();
    userPausedSound = false;
    state.timer.endAt = Date.now() + state.timer.remaining*1000;
    state.timer.running = true;
    startTimerLoop();
    requestWakeLock();
    updateFocusSoundForTimerState();
    autosave();
  };

  $("#resetTimer").onclick = () => {
    stopAlarm();
    userPausedSound = false;
    state.timer.running = false;
    state.timer.endAt = null;
    const activeViewMode = state.timer.selectedMode || state.timer.phase;
    state.timer.phase = activeViewMode;
    state.timer.remaining = (activeViewMode === "focus" ? state.timer.workMinutes : state.timer.breakMinutes) * 60;
    releaseWakeLock();
    updateFocusSoundForTimerState();
    autosave();
  };
  $("#stopAlarm").onclick = stopAlarm;

  $("#focusSoundSelect").addEventListener("change", (e)=>{
    userPausedSound = false;
    state.focusSound.kind = e.target.value;
    updateFocusSoundForTimerState();
    autosave();
  });
  $("#focusSoundVolume").addEventListener("input", (e)=>{
    const v = Number(e.target.value) / 100;
    setFocusSoundVolume(v);
    $("#focusSoundMuteBtn").textContent = v > 0 ? "Mute" : "Unmute";
    autosave();
  });
  $("#focusSoundMuteBtn").addEventListener("click", ()=>{
    if(state.focusSound.volume > 0){
      focusSoundVolumeBeforeMute = state.focusSound.volume;
      setFocusSoundVolume(0);
    }else{
      setFocusSoundVolume(focusSoundVolumeBeforeMute || 0.4);
    }
    renderFocusSoundUI();
    autosave();
  });

  $("#saveCalendarEntry").onclick = ()=>{
    state.calendar[state.selectedDate] = {
      studyHours: Number($("#calendarStudyHours").value || 0),
      notes: $("#calendarNotes").value.trim()
    };
    autosave();
    toast("Calendar entry saved");
  };

  $("#prevMonth").onclick = ()=>{ state.currentMonth--; if(state.currentMonth < 0){ state.currentMonth = 11; state.currentYear--; } autosave(); };
  $("#nextMonth").onclick = ()=>{ state.currentMonth++; if(state.currentMonth > 11){ state.currentMonth = 0; state.currentYear++; } autosave(); };

  $("#exportData").onclick = ()=>{
    const data = JSON.stringify({ ...state, timer: undefined }, null, 2);
    const blob = new Blob([data], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "constancy-checker-data.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("#importData").onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    Object.assign(state, parsed);
    autosave();
    toast("Data imported");
  };

  $("#clearData").onclick = ()=>{
    if(confirm("Clear all saved study data? This cannot be undone.")){
      localStorage.removeItem(storageKey());
      location.reload();
    }
  };

  $("#fontSize").oninput = (e)=>{ state.settings.fontSize = Number(e.target.value); autosave(); };
  $$('input[name="theme"]').forEach(r=> r.addEventListener("change", e => { state.settings.theme = e.target.value; autosave(); }));
  $("#resetSettings").onclick = ()=>{ state.settings = { theme:"dark", fontSize:16 }; autosave(); };

  document.addEventListener("visibilitychange", ()=>{
    if(!document.hidden){
      evaluateTimer(true);
      if(state.timer.running) requestWakeLock();
      renderAll();
    }
  });
}

function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1800);
}

function initNotifications(){
  if("Notification" in window && Notification.permission === "default"){
    Notification.requestPermission();
  }
}

function initApp(){
  loadState();
  bindEvents();
  initNotifications();
  if(!state.timer.remaining) state.timer.remaining = state.timer.workMinutes * 60;

  if(state.timer.running && state.timer.endAt){
    evaluateTimer(true);
  }else if(state.timer.running && !state.timer.endAt){
    state.timer.endAt = Date.now() + state.timer.remaining*1000;
  }

  startTimerLoop();
  if(state.timer.running) requestWakeLock();
  renderAll();
  switchView("home");
  setInterval(renderClock, 1000);
  window.addEventListener("beforeunload", saveState);

  bindIdleDetection();
  startHeartbeat();
  syncActivityIfChanged();

  const resumeModal = $("#resumeSessionModal");
  const resumeBtn = $("#resumeSessionBtn");

  if(state.timer.running && state.focusSound.kind !== "none"){
    if(resumeModal) resumeModal.hidden = false;
  }

  if(resumeBtn){
    resumeBtn.onclick = () => {
      userPausedSound = false;
      focusSoundPlayingKind = null;
      if(resumeModal) resumeModal.hidden = true;
      updateFocusSoundForTimerState();
    };
  }

  window.addEventListener("pagehide", ()=>{
    if(currentStudent){
      updateStudentActivity(currentStudent.uid, {
        status: "offline",
        currentTimer: formatTime(state.timer.remaining)
      });
    }
  });
}

/* =============================================================================
   AUTH SCREEN
============================================================================= */
function showAuthScreen(){
  $("#authScreen").hidden = false;
  $("#appShell").hidden = true;
}
function showApp(){
  $("#authScreen").hidden = true;
  $("#appShell").hidden = false;
}
function setAuthError(msg){
  const el = $("#authError");
  if(!msg){ el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
}
function setAuthTab(tab){
  $$(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.authTab === tab));
  $("#loginForm").hidden = tab !== "login";
  $("#registerForm").hidden = tab !== "register";
  setAuthError("");
}

function openRegistrationSuccessModal(profile){
  $("#modalStudentId").textContent = profile.studentId;
  $("#registrationSuccessModal").hidden = false;
  $("#registrationSuccessModal").dataset.pendingUid = profile.uid;
}

function bindAuthEvents(){
  $$(".auth-tab").forEach(btn => btn.addEventListener("click", () => setAuthTab(btn.dataset.authTab)));

  $("#loginForm").addEventListener("submit", async (e)=>{
    e.preventDefault();
    setAuthError("");
    const studentId = $("#loginStudentId").value;
    const password = $("#loginPassword").value;
    const btn = $("#loginSubmit");
    btn.disabled = true; btn.textContent = "Logging in...";
    try{
      const profile = await loginStudent(studentId, password);
      currentStudent = profile;
      showApp();
      initApp();
    }catch(err){
      setAuthError(friendlyAuthError(err));
    }finally{
      btn.disabled = false; btn.textContent = "Log In";
    }
  });

  $("#registerForm").addEventListener("submit", async (e)=>{
    e.preventDefault();
    setAuthError("");
    const name = $("#registerName").value;
    const password = $("#registerPassword").value;
    const btn = $("#registerSubmit");
    if(password.length < 6){
      setAuthError("Password should be at least 6 characters.");
      return;
    }
    btn.disabled = true; btn.textContent = "Creating account...";
    try{
      const profile = await registerStudent(name, password);
      openRegistrationSuccessModal(profile);
      e.target.reset();
    }catch(err){
      setAuthError(friendlyAuthError(err));
    }finally{
      btn.disabled = false; btn.textContent = "Create Account";
    }
  });

  $("#copyStudentIdBtn").addEventListener("click", async ()=>{
    const id = $("#modalStudentId").textContent;
    try{
      await navigator.clipboard.writeText(id);
    }catch(e){
      const ta = document.createElement("textarea");
      ta.value = id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast("Student ID copied");
  });

  $("#confirmWrittenDownBtn").addEventListener("click", async ()=>{
    const uid = $("#registrationSuccessModal").dataset.pendingUid;
    $("#registrationSuccessModal").hidden = true;
    currentStudent = await getStudentProfile(uid);
    showApp();
    initApp();
  });

  $("#logoutBtn").addEventListener("click", async ()=>{
    stopHeartbeat();
    if(currentStudent){
      await updateStudentActivity(currentStudent.uid, { status:"offline" });
    }
    await logoutStudent();
    location.reload();
  });
}

function friendlyAuthError(err){
  const msg = (err && err.message) || "Something went wrong. Please try again.";
  if(msg.includes("auth/invalid-credential") || msg.includes("auth/wrong-password")) return "Incorrect Student ID or password.";
  if(msg.includes("auth/weak-password")) return "Please choose a longer password (6+ characters).";
  if(msg.includes("couldn't find that Student ID")) return "We couldn't find that Student ID.";
  return msg;
}

/* =============================================================================
   ADMIN DASHBOARD
============================================================================= */
const ADMIN_PASSWORD = "admin4321";
const ADMIN_STALE_MS = 45 * 1000;

let adminUnsubscribe = null;
let adminStudents = [];
let adminSearchTerm = "";
let adminFilterStatus = "all";
let adminSortBy = "studyTime";

function toDateSafe(ts){
  if(!ts) return null;
  if(typeof ts.toDate === "function") return ts.toDate();
  return null;
}
function formatDateTime(ts){
  const d = toDateSafe(ts);
  if(!d) return "—";
  return d.toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
}
function effectiveStatus(student){
  const lastSeen = toDateSafe(student.lastSeen);
  const stale = !lastSeen || (Date.now() - lastSeen.getTime() > ADMIN_STALE_MS);
  if(stale) return "offline";
  return student.status || "offline";
}

function bindAdminEvents(){
  $("#adminTrigger").addEventListener("click", ()=>{
    $("#adminPasswordInput").value = "";
    $("#adminPasswordError").hidden = true;
    $("#adminPasswordModal").hidden = false;
    $("#adminPasswordInput").focus();
  });

  $("#adminPasswordCancel").addEventListener("click", ()=>{
    $("#adminPasswordModal").hidden = true;
  });

  $("#adminPasswordSubmit").addEventListener("click", openAdminDashboard);
  $("#adminPasswordInput").addEventListener("keydown", (e)=>{
    if(e.key === "Enter") openAdminDashboard();
  });

  $("#adminCloseBtn").addEventListener("click", closeAdminDashboard);

  $("#adminSearch").addEventListener("input", (e)=>{
    adminSearchTerm = e.target.value.trim().toLowerCase();
    renderAdminDashboard();
  });
  $("#adminFilter").addEventListener("change", (e)=>{
    adminFilterStatus = e.target.value;
    renderAdminDashboard();
  });
  $("#adminSort").addEventListener("change", (e)=>{
    adminSortBy = e.target.value;
    renderAdminDashboard();
  });

  $("#adminStudentTable").addEventListener("click", async (e)=>{
    const btn = e.target.closest('[data-action="delete-student"]');
    if(!btn) return;
    const { uid, studentId, name } = btn.dataset;
    if(!confirm(`Delete ${name} (${studentId})? This removes their profile and login — this cannot be undone.`)) return;
    btn.disabled = true;
    btn.textContent = "Deleting...";
    try{
      await deleteStudentRecord(uid, studentId);
      toast(`${name} deleted`);
    }catch(err){
      alert("Couldn't delete this student: " + err.message);
      btn.disabled = false;
      btn.textContent = "Delete";
    }
  });

  // Admin Sound Form
  const adminSoundForm = $("#adminSoundForm");
  if(adminSoundForm){
    adminSoundForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const title = $("#adminSoundTitle").value;
      const url = $("#adminSoundUrl").value;
      try{
        await addCustomSoundRecord(title, url);
        toast("Focus sound added successfully!");
        adminSoundForm.reset();
      }catch(err){
        alert("Failed to add sound: " + err.message);
      }
    });
  }

  // Admin Sound Delete
  const adminSoundList = $("#adminSoundList");
  if(adminSoundList){
    adminSoundList.addEventListener("click", async (e)=>{
      const btn = e.target.closest('[data-action="delete-sound"]');
      if(!btn) return;
      const { id, title } = btn.dataset;
      if(!confirm(`Delete focus sound "${title}"?`)) return;
      try{
        await deleteCustomSoundRecord(id);
        toast(`Sound "${title}" deleted`);
      }catch(err){
        alert("Couldn't delete sound: " + err.message);
      }
    });
  }
}

function renderAdminSounds(){
  const list = $("#adminSoundList");
  if(!list) return;

  if(!state.customSounds || state.customSounds.length === 0){
    list.innerHTML = `<p class="empty-note">No custom sounds added yet.</p>`;
    return;
  }

  list.innerHTML = state.customSounds.map(s => `
    <div style="display:flex; align-items:center; justify-content:space-between; background:var(--panel-2); padding:8px 12px; border-radius:12px; border:1px solid var(--line);">
      <span><strong>${escapeHtml(s.title)}</strong></span>
      <div style="display:flex; gap:10px; align-items:center;">
        <audio controls src="${s.audioUrl}" style="height:28px; max-width:180px;"></audio>
        <button class="btn danger admin-delete-btn" data-action="delete-sound" data-id="${s.id}" data-title="${escapeHtml(s.title)}">Delete</button>
      </div>
    </div>
  `).join("");
}

function openAdminDashboard(){
  const entered = $("#adminPasswordInput").value;
  if(entered !== ADMIN_PASSWORD){
    $("#adminPasswordError").hidden = false;
    $("#adminPasswordError").textContent = "Incorrect password.";
    return;
  }
  $("#adminPasswordModal").hidden = true;
  $("#adminDashboard").hidden = false;
  renderAdminSounds();
  if(!adminUnsubscribe){
    adminUnsubscribe = watchAllStudents((students)=>{
      adminStudents = students;
      renderAdminDashboard();
    });
  }
}

function closeAdminDashboard(){
  $("#adminDashboard").hidden = true;
  if(adminUnsubscribe){ adminUnsubscribe(); adminUnsubscribe = null; }
}

function renderAdminDashboard(){
  const withStatus = adminStudents.map(s => ({ ...s, _status: effectiveStatus(s) }));

  $("#adminTotalStudents").textContent = withStatus.length;
  $("#adminOnlineStudents").textContent = withStatus.filter(s=>s._status==="online").length;
  $("#adminOfflineStudents").textContent = withStatus.filter(s=>s._status==="offline").length;
  $("#adminIdleStudents").textContent = withStatus.filter(s=>s._status==="idle").length;
  $("#adminStudyingStudents").textContent = withStatus.filter(s=>s._status==="studying").length;

  let list = withStatus;
  if(adminFilterStatus !== "all") list = list.filter(s => s._status === adminFilterStatus);
  if(adminSearchTerm){
    list = list.filter(s =>
      (s.name||"").toLowerCase().includes(adminSearchTerm) ||
      (s.studentId||"").toLowerCase().includes(adminSearchTerm)
    );
  }

  const sortKey = { studyTime:"totalStudyHours", completedTasks:"completedTasks", studyStreak:"studyStreak" }[adminSortBy];
  list = [...list].sort((a,b) => (b[sortKey]||0) - (a[sortKey]||0));

  const rows = list.map(s => [
    escapeHtml(s.name || "—"),
    s.studentId || "—",
    capitalize(s._status),
    s.currentTimer || "—",
    formatMinutes(s.todayStudyTime || 0),
    formatMinutes(s.weeklyStudyTime || 0),
    formatMinutes(s.monthlyStudyTime || 0),
    `${(s.totalStudyHours || 0).toFixed(1)}h`,
    s.completedTasks || 0,
    `${s.studyStreak || 0} days`,
    formatDateTime(s.lastActiveTime),
    formatDateTime(s.lastLogin),
    formatDateTime(s.lastSeen),
    formatDateTime(s.registrationDate),
    `<button class="btn danger admin-delete-btn" data-action="delete-student" data-uid="${s.uid}" data-student-id="${s.studentId||""}" data-name="${escapeHtml(s.name||"this student")}">Delete</button>`
  ]);

  $("#adminStudentTable").innerHTML = rows.length
    ? renderTable(
        ["Name","Student ID","Status","Timer","Today","Weekly","Monthly","Total Hours","Tasks Done","Streak","Last Active","Last Login","Last Seen","Registered","Action"],
        rows
      )
    : `<p class="empty-note">No students match this view.</p>`;
}

function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* =============================================================================
   AUTH BOOTSTRAP
============================================================================= */
bindAuthEvents();
bindAdminEvents();

watchCustomSounds((sounds) => {
  state.customSounds = sounds;
  renderFocusSoundUI();
  renderAdminSounds();
  if(state.timer.running && state.timer.phase === "focus" && !userPausedSound){
    focusSoundPlayingKind = null;
    updateFocusSoundForTimerState();
  }
});

watchAuthState(async (user)=>{
  if(user){
    currentStudent = await getStudentProfile(user.uid);
    if(currentStudent){
      showApp();
      initApp();
      return;
    }
  }
  currentStudent = null;
  showAuthScreen();
});

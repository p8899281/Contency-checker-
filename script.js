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
  revisions: [],
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
let isClearingData = false;
let appBootstrapped = false; // guards against initApp() running its one-time setup more than once
let progressChartWeekOffset = 0; // 0 = current 7 days ending today, 1 = the 7 days before that, etc.
let monthlyTrendRangeDays = 30; // 30 | 90 | 180 | "all"

// 🔊 Silent Audio Engine to Force Android Background Execution
let keepAliveAudio = null;
function createSilentWavBlobUrl() {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const buffer = new Uint8Array(44 + numSamples);
  buffer.set([
    0x52,0x49,0x46,0x46, 36+numSamples,0,0,0, 0x57,0x41,0x56,0x45, 
    0x66,0x6d,0x74,0x20, 16,0,0,0, 1,0, 1,0, 0x40,0x1f,0,0, 0x40,0x1f,0,0, 1,0, 8,0, 
    0x64,0x61,0x74,0x61, numSamples,0,0,0
  ]);
  for(let i=0; i<numSamples; i++) buffer[44+i] = 128;
  return URL.createObjectURL(new Blob([buffer], {type: "audio/wav"}));
}
const SILENT_WAV_URL = createSilentWavBlobUrl();

function startKeepAliveAudio() {
  if (!keepAliveAudio) {
    keepAliveAudio = new Audio(SILENT_WAV_URL);
    keepAliveAudio.loop = true;
    keepAliveAudio.volume = 0.01;
  }
  keepAliveAudio.play().catch(() => {});
}

function stopKeepAliveAudio() {
  if (keepAliveAudio) {
    try {
      keepAliveAudio.pause();
      keepAliveAudio.currentTime = 0;
    } catch(e) {}
  }
}

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
      state.revisions = Array.isArray(saved.revisions) ? saved.revisions : [];
      
      if(state.tasks && Array.isArray(state.tasks)){
        state.tasks.forEach(t => {
          if(!t.createdAt) t.createdAt = todayISO();
          if(t.done && !t.completedAt) t.completedAt = t.createdAt;
        });
      }
    }
    const settings = JSON.parse(localStorage.getItem(settingsKey()));
    if(settings) state.settings = Object.assign(state.settings, settings);
  }catch(e){}
}

function saveState(){
  if (isClearingData) return;
  const persist = {
    tasks: state.tasks,
    // Only revisions the user has acted on are stored. Untouched ones are fully determined by
    // task.revisionAnchor and are regenerated (same ids) by syncRevisions(), which keeps the
    // saved data small no matter how many tasks/years accumulate.
    revisions: state.revisions.filter(isTouchedRevision),
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
  const completedToday = todaysTasks.filter(t => t.done && t.completedAt === today).length;
  const pendingToday = todaysTasks.filter(t => !t.done).length;
  const pendingCompletedToday = state.tasks.filter(t => t.done && t.completedAt === today && t.createdAt < today).length;

  return {
    totalToday: todaysTasks.length,
    completedToday,
    pendingToday,
    pendingCompletedToday,
    completionPercent: todaysTasks.length ? Math.round((completedToday / todaysTasks.length) * 100) : 0
  };
}

function parseDateKey(key){
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d); // always local midnight, no UTC-string ambiguity
}

function studyMinutesForRange(start, end){
  return state.focusSessions.reduce((sum,s)=>{
    const d = parseDateKey(s.date);
    if(d >= start && d <= end) return sum + (s.minutes || 0);
    return sum;
  }, 0);
}

// Task-based progress for any date range (carry-forward aware):
// "assigned" = tasks created within the range
// "completed" = tasks finished within the range (even if created earlier and carried over)
function taskProgressForRange(start, end){
  const startKey = localDateKey(start);
  const endKey = localDateKey(end);

  const assigned = state.tasks.filter(t => t.createdAt >= startKey && t.createdAt <= endKey).length;
  const completed = state.tasks.filter(t =>
    t.done && t.completedAt && t.completedAt >= startKey && t.completedAt <= endKey
  ).length;

  return {
    assigned,
    completed,
    percent: assigned ? Math.round((completed / assigned) * 100) : 0
  };
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
  const sixMonthStart = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());

  const todayMinutes = studyMinutesForRange(new Date(today+"T00:00:00"), new Date(today+"T23:59:59"));
  const weekMinutes = studyMinutesForRange(weekStart, now);
  const monthMinutes = studyMinutesForRange(monthStart, now);
  const sixMonthMinutes = studyMinutesForRange(sixMonthStart, now);
  const totalMinutesAllTime = state.focusSessions.reduce((sum,s) => sum + (s.minutes || 0), 0);

  const totalStudyDays = [...new Set(state.focusSessions.map(s => s.date))].length || 1;
  const avg = Math.round(totalMinutesAllTime / totalStudyDays);

  const completedTasks = state.tasks.filter(t => t.done).length;
  const totalTasksAllTime = state.tasks.length;

  const totalCompletedSameDay = state.tasks.filter(t => t.done && t.completedAt && t.completedAt === t.createdAt).length;
  const totalCompletedPending = state.tasks.filter(t => t.done && t.completedAt && t.completedAt > t.createdAt).length;

  const streak = calculateStreak();
  const st = taskStats();

  // Overall progress = average of Task %, Revision % and Study-Hours %
  const weekProgress = overallProgressForRange(weekStart, now);
  const monthProgress = overallProgressForRange(monthStart, now);
  const sixMonthProgress = overallProgressForRange(sixMonthStart, now);

  if($("#todayTasksCount")) $("#todayTasksCount").textContent = st.totalToday;
  if($("#pendingTasksCount")) $("#pendingTasksCount").textContent = st.pendingToday;
  if($("#completedTasksCount")) $("#completedTasksCount").textContent = st.completedToday;
  if($("#todayStudyHours")) $("#todayStudyHours").textContent = formatMinutes(todayMinutes);
  if($("#completionPercent")) $("#completionPercent").textContent = `${st.completionPercent}%`;

  if($("#sidebarStreak")) $("#sidebarStreak").textContent = `${streak} days`;
  if($("#sidebarTodayHours")) $("#sidebarTodayHours").textContent = formatMinutes(todayMinutes);

  if($("#dashTotalHours")) $("#dashTotalHours").textContent = formatMinutes(totalMinutesAllTime);
  if($("#dashTotalTasks")) $("#dashTotalTasks").textContent = totalTasksAllTime;
  if($("#dashTotalCompletedSameDay")) $("#dashTotalCompletedSameDay").textContent = totalCompletedSameDay;
  if($("#dashTotalCompletedPending")) $("#dashTotalCompletedPending").textContent = totalCompletedPending;
  if($("#dashStreak")) $("#dashStreak").textContent = `${streak} days`;
  setProgressCard("dashWeeklyProgress", "dashWeeklyBreakdown", weekProgress);
  setProgressCard("dashMonthlyProgress", "dashMonthlyBreakdown", monthProgress);
  setProgressCard("dash6MonthProgress", "dash6MonthBreakdown", sixMonthProgress);

  if($("#statsToday")) $("#statsToday").textContent = formatMinutes(todayMinutes);
  if($("#statsWeekly")) $("#statsWeekly").textContent = formatMinutes(weekMinutes);
  if($("#statsMonthly")) $("#statsMonthly").textContent = formatMinutes(monthMinutes);
  if($("#statsStreak")) $("#statsStreak").textContent = `${streak} days`;
  if($("#statsCompleted")) $("#statsCompleted").textContent = completedTasks;
  if($("#statsAverage")) $("#statsAverage").textContent = formatMinutes(avg);

  const circle = $("#progressCircle");
  if(circle){
    const percent = st.completionPercent;
    const dash = 314 - (314 * percent / 100);
    circle.style.strokeDashoffset = dash;
  }
}

function calculateStreak(){
  const minsPerDay = {};
  state.focusSessions.forEach(s => {
    minsPerDay[s.date] = (minsPerDay[s.date] || 0) + (s.minutes || 0);
  });

  const validDays = Object.keys(minsPerDay).filter(d => minsPerDay[d] >= 1);
  if(!validDays.length) return 0;

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0,0,0,0);

  const todayKey = dateKey(cursor);
  if (!validDays.includes(todayKey)) {
    cursor.setDate(cursor.getDate() - 1);
  }

  while(true){
    const key = dateKey(cursor);
    if(validDays.includes(key)){
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function renderTasks(){
  const list = $("#taskList");
  list.innerHTML = "";
  const today = todayISO();
  const tasksWithRevisions = new Set(state.revisions.map(r => r.taskId));

  state.tasks
    .filter(t => t.createdAt === today || (!t.done && t.createdAt < today))
    .sort((a,b)=> (a.done - b.done) || ({High:0,Medium:1,Low:2}[a.priority]-{High:0,Medium:1,Low:2}[b.priority]))
    .forEach(task => {
      const isPendingFromPast = !task.done && task.createdAt < today;
      const el = document.createElement("div");
      el.className = `task-item ${task.done ? "done" : ""}`;
      el.innerHTML = `
        <div>
          <strong>${escapeHtml(task.title)} ${isPendingFromPast ? `<span style="color:#e8a33d; font-size:12px;">(Pending from ${task.createdAt})</span>` : ""}</strong>
          <div class="muted">${escapeHtml(task.subject)} · ${task.priority}</div>
        </div>
        <div class="task-actions">
          <button class="btn ghost" data-action="toggle" data-id="${task.id}">${task.done ? "Undo" : "Complete"}</button>
          ${tasksWithRevisions.has(task.id) ? `<button class="btn secondary" data-action="revisions" data-id="${task.id}">Revision History</button>` : ""}
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
    const createdTasks = state.tasks.filter(t => t.createdAt === iso).length;
    const cell = document.createElement("div");
    cell.className = `day-cell ${iso === state.selectedDate ? "selected" : ""}`;
    cell.innerHTML = `<div class="day-num">${day}</div><div class="day-meta">${formatMinutes(focusMins)} · ${createdTasks} tasks</div>`;
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

  const iso = state.selectedDate;
  const tasksCreated = state.tasks.filter(t => t.createdAt === iso);
  const totalCreated = tasksCreated.length;
  const completedToday = tasksCreated.filter(t => t.done && t.completedAt === iso).length;
  const pendingToday = tasksCreated.filter(t => !t.done).length;
  const pendingCompletedToday = state.tasks.filter(t => t.done && t.completedAt === iso && t.createdAt < iso).length;

  const focusMins = state.focusSessions.filter(s => s.date === iso).reduce((a,b)=>a+b.minutes,0);
  const revsThatDay = state.revisions.filter(r => r.dueDate === iso);
  const revsDoneThatDay = revsThatDay.filter(r => r.status === "completed").length;

  const summaryEl = $("#daySummary");
  if(summaryEl){
    summaryEl.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:6px; font-size:14px; margin-top:6px;">
        <div>📊 <strong>Total Tasks Created:</strong> ${totalCreated}</div>
        <div>✅ <strong>Completed Today:</strong> ${completedToday}</div>
        <div>⏳ <strong>Pending Today:</strong> ${pendingToday}</div>
        <div>🔄 <strong>Pending Completed Today:</strong> ${pendingCompletedToday}</div>
        <div>⏱️ <strong>Study Time:</strong> ${formatMinutes(focusMins)}</div>
        <div>🔁 <strong>Revisions:</strong> ${revsThatDay.length} due · ${revsDoneThatDay} done</div>
      </div>
    `;
  }
}

function renderSettings(){
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.style.setProperty("--base-font", `${state.settings.fontSize}px`);
  $(`input[name="theme"][value="${state.settings.theme}"]`).checked = true;
  $("#fontSize").value = state.settings.fontSize;
  const goalInput = $("#dailyGoalHours");
  if(goalInput && document.activeElement !== goalInput) goalInput.value = getDailyGoalHours();
}

function syncMediaSessionAndNotification() {
  if (!state.timer.running) {
    stopKeepAliveAudio();
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "UPDATE_TIMER_NOTIFICATION",
        running: false
      });
    }
    return;
  }

  // Only needed to keep the timer accurate while the tab is backgrounded —
  // playing it in the foreground serves no purpose and was ducking the
  // volume of other apps (e.g. YouTube) via the OS audio-focus system.
  if (document.hidden) {
    startKeepAliveAudio();
  } else {
    stopKeepAliveAudio();
  }

  const timeText = formatTime(state.timer.remaining);
  const phaseText = state.timer.phase.toUpperCase();

  // MediaSession Metadata Update
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `⏱️ ${timeText} (${phaseText})`,
        artist: 'Constancy Checker by Soumen',
        album: 'Focus Session Active'
      });
      navigator.mediaSession.playbackState = 'playing';
    } catch(e) {}
  }

  // Service Worker Notification Sync
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "UPDATE_TIMER_NOTIFICATION",
      running: true,
      timeText: timeText,
      phase: state.timer.phase
    });
  }
}

function renderTimer(){
  const timeFormatted = formatTime(state.timer.remaining);
  const modeText = state.timer.phase === "focus" ? "Focus" : "Break";

  $("#timerDisplay").textContent = timeFormatted;
  $("#timerMode").textContent = modeText;
  
  if(state.timer.running){
    document.title = `⏱️ (${timeFormatted}) ${modeText} - constancy checker`;
  } else {
    document.title = `constancy checker by soumen`;
  }

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

  syncMediaSessionAndNotification();
}

function renderTimerActiveState(){
  const circle = $("#timerCircle");
  if(circle) circle.classList.toggle("is-running", !!state.timer.running);
}

function renderChart(){
  const canvas = $("#progressChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const dayShift = progressChartWeekOffset * 7;
  const days = Array.from({length:7}, (_,i)=>{
    const d = new Date();
    d.setDate(d.getDate() - (6-i) - dayShift);
    d.setHours(0,0,0,0);
    return d;
  });

  const values = days.map(d => studyMinutesForRange(d, new Date(d.getTime() + 86399999)) / 60);
  const max = Math.max(1, ...values);
  const barW = 90;
  const gap = 35;
  const startX = 35;

  values.forEach((v,i)=>{
    const x = startX + i*(barW+gap);
    const barH = (v/max) * 165;
    ctx.fillStyle = "rgba(232,163,61,.8)";
    roundRect(ctx, x, 220-barH, barW, barH, 16, true, false);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text");
    ctx.fillText(days[i].toLocaleDateString(undefined,{weekday:"short"}), x+18, 242);
    ctx.fillText(v.toFixed(1)+"h", x+18, 205-barH);
  });

  const offsetLabel = $("#progressChartOffsetLabel");
  if(offsetLabel){
    if(progressChartWeekOffset === 0){
      offsetLabel.textContent = "This week";
    }else{
      const startLabel = days[0].toLocaleDateString(undefined,{month:"short",day:"numeric"});
      const endLabel = days[6].toLocaleDateString(undefined,{month:"short",day:"numeric"});
      offsetLabel.textContent = `${startLabel} – ${endLabel}`;
    }
  }
  const nextBtn = $("#progressChartNext");
  if(nextBtn) nextBtn.disabled = progressChartWeekOffset === 0;
}

function renderMonthlyTrendChart(){
  const canvas = $("#monthlyTrendChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  let rangeDays = monthlyTrendRangeDays;
  if(rangeDays === "all"){
    if(state.focusSessions.length){
      const earliestKey = state.focusSessions.reduce((min,s) => s.date < min ? s.date : min, state.focusSessions[0].date);
      const earliest = parseDateKey(earliestKey);
      const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
      rangeDays = Math.max(1, Math.round((todayMidnight - earliest) / 86400000) + 1);
    }else{
      rangeDays = 30;
    }
  }

  const days = Array.from({length:rangeDays}, (_,i)=>{
    const d = new Date();
    d.setDate(d.getDate() - (rangeDays-1-i));
    d.setHours(0,0,0,0);
    return d;
  });
  const values = days.map(d => studyMinutesForRange(d, new Date(d.getTime()+86399999))/60);
  const max = Math.max(1, ...values);

  const paddingLeft = 46;
  const paddingRight = 10;
  const paddingTop = 14;
  const paddingBottom = 26;
  const plotW = w - paddingLeft - paddingRight;
  const plotH = h - paddingTop - paddingBottom;
  const stepX = values.length > 1 ? plotW/(values.length-1) : 0;

  // Y-axis gridlines + hour labels
  const gridLines = 4;
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.textAlign = "right";
  for(let i=0;i<=gridLines;i++){
    const val = max * (i/gridLines);
    const y = paddingTop + plotH - (val/max)*plotH;

    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--line");
    ctx.globalAlpha = i===0 ? 1 : 0.35;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(w-paddingRight, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    const label = val >= 1 ? `${val.toFixed(1)}h` : `${Math.round(val*60)}m`;
    ctx.fillText(label, paddingLeft-8, y+4);
  }
  ctx.textAlign = "start";

  // Line + fill
  ctx.beginPath();
  values.forEach((v,i)=>{
    const x = paddingLeft + i*stepX;
    const y = paddingTop + plotH - (v/max)*plotH;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.strokeStyle = "#e8a33d";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(paddingLeft+plotW, paddingTop+plotH);
  ctx.lineTo(paddingLeft, paddingTop+plotH);
  ctx.closePath();
  ctx.fillStyle = "rgba(232,163,61,.15)";
  ctx.fill();

  // X-axis date labels
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
  ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.fillText(days[0].toLocaleDateString(undefined,{month:"short",day:"numeric"}), paddingLeft, h-8);
  const lastLabel = days[days.length-1].toLocaleDateString(undefined,{month:"short",day:"numeric"});
  ctx.fillText(lastLabel, w-paddingRight-ctx.measureText(lastLabel).width, h-8);

  const rangeLabel = $("#trendRangeLabel");
  if(rangeLabel){
    rangeLabel.textContent = monthlyTrendRangeDays === "all" ? `All time (${rangeDays} days)` : `Last ${rangeDays} days`;
  }
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

function renderWeeklyComparisonChart(){
  const canvas = $("#weeklyComparisonChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const thisWeekStart = startOfWeek(new Date());
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const dayLabels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const thisWeekValues = dayLabels.map((_,i)=>{
    const d = new Date(thisWeekStart); d.setDate(d.getDate()+i);
    return studyMinutesForRange(d, new Date(d.getTime()+86399999))/60;
  });
  const lastWeekValues = dayLabels.map((_,i)=>{
    const d = new Date(lastWeekStart); d.setDate(d.getDate()+i);
    return studyMinutesForRange(d, new Date(d.getTime()+86399999))/60;
  });

  const max = Math.max(1, ...thisWeekValues, ...lastWeekValues);
  const paddingLeft = 42, paddingRight = 10, paddingTop = 16, paddingBottom = 28;
  const plotW = w - paddingLeft - paddingRight;
  const plotH = h - paddingTop - paddingBottom;
  const groupW = plotW / 7;
  const barW = groupW * 0.3;
  const barGap = groupW * 0.1;

  const gridLines = 4;
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.textAlign = "right";
  for(let i=0;i<=gridLines;i++){
    const val = max * (i/gridLines);
    const y = paddingTop + plotH - (val/max)*plotH;
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--line");
    ctx.globalAlpha = i===0 ? 1 : 0.35;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(w-paddingRight, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.fillText(`${val.toFixed(1)}h`, paddingLeft-8, y+4);
  }
  ctx.textAlign = "start";

  dayLabels.forEach((label,i)=>{
    const groupX = paddingLeft + i*groupW;
    const lastH = (lastWeekValues[i]/max) * plotH;
    const thisH = (thisWeekValues[i]/max) * plotH;

    ctx.fillStyle = "rgba(255,255,255,.22)";
    roundRect(ctx, groupX + barGap, paddingTop+plotH-lastH, barW, lastH, 5, true, false);

    ctx.fillStyle = "rgba(232,163,61,.85)";
    roundRect(ctx, groupX + barGap*2 + barW, paddingTop+plotH-thisH, barW, thisH, 5, true, false);

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.font = "12px 'JetBrains Mono', monospace";
    ctx.fillText(label, groupX + groupW/2 - 12, h-8);
  });

  const legend = $("#weeklyComparisonLegend");
  if(legend){
    const thisTotal = thisWeekValues.reduce((a,b)=>a+b,0);
    const lastTotal = lastWeekValues.reduce((a,b)=>a+b,0);
    legend.innerHTML = `
      <div class="legend-row"><span class="swatch" style="background:rgba(232,163,61,.85)"></span>This week · ${thisTotal.toFixed(1)}h</div>
      <div class="legend-row"><span class="swatch" style="background:rgba(255,255,255,.22)"></span>Last week · ${lastTotal.toFixed(1)}h</div>
    `;
  }
}

function renderTaskTimingChart(){
  const canvas = $("#taskTimingChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const onTime = state.tasks.filter(t => t.done && t.completedAt && t.completedAt === t.createdAt).length;
  const carriedOver = state.tasks.filter(t => t.done && t.completedAt && t.completedAt > t.createdAt).length;
  const total = onTime + carriedOver;
  const cx = w/2, cy = h/2, r = Math.min(w,h)/2 - 18;

  const legend = $("#taskTimingLegend");

  if(total === 0){
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.font = "14px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No completed tasks yet", cx, cy);
    ctx.textAlign = "start";
    if(legend) legend.innerHTML = `<p class="empty-note">Complete a task to see this chart.</p>`;
    return;
  }

  const onTimeAngle = (onTime/total) * Math.PI*2;
  ctx.lineWidth = 26;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(cx,cy,r, -Math.PI/2 + onTimeAngle, Math.PI*1.5);
  ctx.strokeStyle = "rgba(232,163,61,.5)";
  ctx.stroke();

  if(onTime > 0){
    ctx.beginPath();
    ctx.arc(cx,cy,r, -Math.PI/2, -Math.PI/2 + onTimeAngle);
    ctx.strokeStyle = "#4f9d69";
    ctx.stroke();
  }

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text");
  ctx.font = "700 22px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round((onTime/total)*100)}%`, cx, cy+8);
  ctx.textAlign = "start";

  if(legend){
    legend.innerHTML = `
      <div class="legend-row"><span class="swatch" style="background:#4f9d69"></span>On-time · ${onTime}</div>
      <div class="legend-row"><span class="swatch" style="background:rgba(232,163,61,.5)"></span>Carried-over · ${carriedOver}</div>
    `;
  }
}

function renderSubjectBreakdownChart(){
  const canvas = $("#subjectBreakdownChart");
  if(!canvas) return;
  const legend = $("#subjectBreakdownLegend");

  const bySubject = {};
  state.tasks.forEach(t=>{
    const subject = (t.subject && t.subject.trim()) || "No Subject";
    if(!bySubject[subject]) bySubject[subject] = { completed:0, pending:0 };
    if(t.done) bySubject[subject].completed++; else bySubject[subject].pending++;
  });

  const subjects = Object.keys(bySubject).sort((a,b)=>{
    const totalA = bySubject[a].completed + bySubject[a].pending;
    const totalB = bySubject[b].completed + bySubject[b].pending;
    return totalB - totalA;
  });

  if(subjects.length === 0){
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.font = "14px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Add a task with a subject to see this chart.", canvas.width/2, 48);
    ctx.textAlign = "start";
    if(legend) legend.innerHTML = "";
    return;
  }

  const rowH = 46;
  const paddingTop = 10, paddingBottom = 10;
  canvas.height = subjects.length * rowH + paddingTop + paddingBottom;

  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const maxCount = Math.max(1, ...subjects.map(s => bySubject[s].completed + bySubject[s].pending));
  const labelW = 140;
  const plotW = w - labelW - 30;

  subjects.forEach((subject,i)=>{
    const y = paddingTop + i*rowH;
    const { completed, pending } = bySubject[subject];

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text");
    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "start";
    let label = subject;
    if(ctx.measureText(label).width > labelW-10){
      while(ctx.measureText(label+"…").width > labelW-10 && label.length>1){
        label = label.slice(0,-1);
      }
      label += "…";
    }
    ctx.fillText(label, 0, y + rowH/2 + 5);

    const completedW = Math.max((completed/maxCount) * plotW, completed>0?4:0);
    const pendingW = Math.max((pending/maxCount) * plotW, pending>0?4:0);

    ctx.fillStyle = "#4f9d69";
    roundRect(ctx, labelW, y + 6, completedW, 14, 4, true, false);

    ctx.fillStyle = "rgba(232,163,61,.6)";
    roundRect(ctx, labelW, y + 25, pendingW, 14, 4, true, false);

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted");
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillText(`${completed}`, labelW + completedW + 6, y + 17);
    ctx.fillText(`${pending}`, labelW + pendingW + 6, y + 36);
  });

  if(legend){
    legend.innerHTML = `
      <div class="legend-row"><span class="swatch" style="background:#4f9d69"></span>Completed</div>
      <div class="legend-row"><span class="swatch" style="background:rgba(232,163,61,.6)"></span>Pending</div>
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
        ["Created Date","Completed Date","Title","Subject","Priority","Status"],
        tasksSorted.map(t=>[t.createdAt, t.completedAt || "—", escapeHtml(t.title), escapeHtml(t.subject), t.priority, t.done ? "Done" : "Pending"])
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
  ctx.lineTo(x + radius.tl, y + height);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

/* =============================================================================
   🔁 AUTOMATIC REVISION SYSTEM
   -----------------------------------------------------------------------------
   Schedule — anchored to the ACTUAL completion date (never the creation date):
     Revision 1 → completion + 3 days
     Revision 2 → completion + 10 days           (+7 after Revision 1)
     Revision n → completion + 10 + 14·(n − 2)   for n ≥ 3 (every 14 days, forever)
   Each revision is stored once under the id "<taskId>::r<n>", so re-running the
   sync (page load, refresh, re-render) can never create duplicates.
   All dates are local "YYYY-MM-DD" keys — never UTC.
============================================================================= */
const REVISION_HORIZON_DAYS = 62;      // how far ahead records are materialised
const DEFAULT_DAILY_GOAL_HOURS = 4;    // Study-Hours % target when the user hasn't set one
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_STATUS_LABEL = { completed:"Completed", upcoming:"Upcoming", due:"Due Today", pending:"Pending" };

let revisionChartRange = "today";      // today | week | month | 6m | all
let revisionHistoryTaskId = null;      // null = all tasks
let revisionLastDay = "";

/* ---------- dates ---------- */
function addDaysKey(key, n){
  const [y, m, d] = key.split("-").map(Number);
  return localDateKey(new Date(y, m - 1, d + n)); // local calendar arithmetic, DST/UTC safe
}
function formatDisplayDate(key){
  if(!DATE_KEY_RE.test(key || "")) return "—";
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}
function sixMonthStartDate(now){
  return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); // same window the Dashboard already used
}

/* ---------- schedule ---------- */
function revisionOffsetDays(n){
  if(n <= 1) return 3;
  if(n === 2) return 10;
  return 10 + 14 * (n - 2);
}
function revisionDueDate(anchorKey, n){ return addDaysKey(anchorKey, revisionOffsetDays(n)); }
function revisionId(taskId, n){ return `${taskId}::r${n}`; }
function isTouchedRevision(r){ return r.status === "completed" || !!(r.remark && r.remark.trim()); }

// Stored status is "scheduled" | "completed". Upcoming / Due Today / Pending(overdue) are derived from the date.
function revisionStatusOf(rev, today = todayISO()){
  if(rev.status === "completed") return "completed";
  if(rev.dueDate > today) return "upcoming";
  if(rev.dueDate === today) return "due";
  return "pending";
}

/* Idempotent: creates any missing revision records, removes exact duplicates and orphans.
   Returns true when something changed (caller persists). */
let revisionSyncKey = "", revisionSyncTasksRef = null, revisionSyncRevsRef = null;
function currentRevisionSyncKey(){
  let anchored = 0;
  for(const t of state.tasks) if(t.done && t.revisionAnchor) anchored++;
  return `${todayISO()}|${state.tasks.length}|${anchored}|${state.revisions.length}`;
}
function syncRevisions(force){
  if(!Array.isArray(state.revisions)) state.revisions = [];
  // renderAll() runs every second while the timer is on: skip the work when nothing relevant changed
  if(!force && revisionSyncKey === currentRevisionSyncKey()
     && revisionSyncTasksRef === state.tasks && revisionSyncRevsRef === state.revisions) return false;
  let changed = false;
  const taskMap = new Map(state.tasks.map(t => [t.id, t]));
  const byId = new Map();
  const kept = [];

  for(const r of state.revisions){
    if(!r || !r.id || !r.taskId || !DATE_KEY_RE.test(r.dueDate || "") || !taskMap.has(r.taskId)){ changed = true; continue; }
    const first = byId.get(r.id);
    if(first){                       // duplicate id → keep one record, never lose completion/remark
      changed = true;
      if(first.status !== "completed" && r.status === "completed"){ first.status = "completed"; first.completedDate = r.completedDate || first.completedDate; }
      if(!first.remark && r.remark) first.remark = r.remark;
      continue;
    }
    byId.set(r.id, r);
    kept.push(r);
  }

  const today = todayISO();
  const horizonKey = addDaysKey(today, REVISION_HORIZON_DAYS);
  const uid = currentStudent ? currentStudent.uid : "guest";
  for(const t of state.tasks){
    if(!t.done || !DATE_KEY_RE.test(t.revisionAnchor || "")) continue; // only tasks completed via the new system
    for(let n = 1; ; n++){
      const due = revisionDueDate(t.revisionAnchor, n);
      if(due > horizonKey) break;
      const id = revisionId(t.id, n);
      if(byId.has(id)) continue;
      const rec = { id, taskId:t.id, uid, number:n, dueDate:due, status:"scheduled", completedDate:null, remark:"", createdAt:t.revisionAnchor };
      byId.set(id, rec);
      kept.push(rec);
      changed = true;
    }
  }
  if(changed) state.revisions = kept;
  revisionSyncKey = currentRevisionSyncKey();
  revisionSyncTasksRef = state.tasks;
  revisionSyncRevsRef = state.revisions;
  return changed;
}

/* ---------- single source of truth for every revision number (Home, Stats, Progress) ---------- */
function revisionRangeCounts(startKey, endKey){
  let total = 0, completed = 0;
  for(const r of state.revisions){
    if(r.dueDate >= startKey && r.dueDate <= endKey){
      total++;
      if(r.status === "completed") completed++;
    }
  }
  return { total, completed, pending: total - completed, ratio: total ? completed / total : null };
}
const OVERDUE_PREVIEW = 10;
let revisionShowAllOverdue = false;
const byDueThenNumber = (a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.number - b.number);
// One pass: total overdue + the oldest OVERDUE_PREVIEW of them (or all, when expanded)
function overdueSummary(today){
  let count = 0;
  let items = [];
  for(const r of state.revisions){
    if(r.status === "completed" || r.dueDate >= today) continue;
    count++;
    if(revisionShowAllOverdue){ items.push(r); continue; }
    if(items.length < OVERDUE_PREVIEW || byDueThenNumber(r, items[items.length - 1]) < 0){
      items.push(r);
      items.sort(byDueThenNumber);
      if(items.length > OVERDUE_PREVIEW) items.pop();
    }
  }
  if(revisionShowAllOverdue) items.sort(byDueThenNumber);
  return { count, items };
}

/* ---------- progress = (Task % + Revision % + Study-Hours %) / 3 ---------- */
function getDailyGoalHours(){
  const g = Number(state.settings && state.settings.dailyStudyGoalHours);
  return g > 0 ? g : DEFAULT_DAILY_GOAL_HOURS;
}
function trackingStartKey(){
  let first = null;
  for(const s of state.focusSessions) if(DATE_KEY_RE.test(s.date || "") && (!first || s.date < first)) first = s.date;
  for(const t of state.tasks) if(DATE_KEY_RE.test(t.createdAt || "") && (!first || t.createdAt < first)) first = t.createdAt;
  return first;
}
// Share of the daily goal reached, day by day (a long day can't cover for a skipped day).
// Days before the user started using the app are not counted against them.
function studyRatioForRange(start, end){
  const goal = getDailyGoalHours() * 60;
  const first = trackingStartKey();
  if(!first) return null;
  let startKey = localDateKey(start);
  const endKey = localDateKey(end);
  if(startKey < first) startKey = first;
  if(startKey > endKey) return null;

  const byDay = {};
  for(const s of state.focusSessions) byDay[s.date] = (byDay[s.date] || 0) + (s.minutes || 0);

  let days = 0, achieved = 0;
  for(let k = startKey; k <= endKey; k = addDaysKey(k, 1)){
    days++;
    achieved += Math.min(byDay[k] || 0, goal);
  }
  return days ? achieved / (days * goal) : null;
}
function overallProgressForRange(start, end){
  const tp = taskProgressForRange(start, end);
  const task = tp.assigned ? Math.min(1, tp.completed / tp.assigned) : null;
  const revision = revisionRangeCounts(localDateKey(start), localDateKey(end)).ratio;
  const study = studyRatioForRange(start, end);
  // A part with nothing scheduled in the period (e.g. no revision due yet) has no basis, so it is
  // left out instead of counting as 0%. With all three present this is exactly (T + R + S) / 3.
  const parts = [task, revision, study].filter(v => v !== null);
  const overall = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { task, revision, study, overall };
}
function fmtPercent(ratio){
  if(ratio === null || ratio === undefined) return "—";
  return `${Math.round(ratio * 10000) / 100}%`;
}
function setProgressCard(valueId, breakdownId, p){
  const v = $("#" + valueId);
  if(v) v.textContent = fmtPercent(p.overall);
  const b = $("#" + breakdownId);
  if(b) b.textContent = `Tasks ${fmtPercent(p.task)} · Revision ${fmtPercent(p.revision)} · Study ${fmtPercent(p.study)}`;
}

/* ---------- actions ---------- */
function setRevisionComplete(id, done){
  const r = state.revisions.find(x => x.id === id);
  if(!r) return;
  if(done){
    if(r.dueDate > todayISO()){ toast("This revision isn't due yet"); return; }
    r.status = "completed";
    r.completedDate = todayISO();
  }else{
    r.status = "scheduled";
    r.completedDate = null;
  }
  autosave();
}

function taskForRevision(rev){ return state.tasks.find(t => t.id === rev.taskId); }

/* ---------- Home: Revision card ---------- */
let lastRevisionHomeHtml = { today:"", overdue:"" };

function revisionRowHtml(rev, task, today){
  const st = revisionStatusOf(rev, today);
  const rid = escapeHtml(rev.id);
  const remark = (rev.remark || "").trim();
  const lateNote = st === "pending" ? `<span>due ${formatDisplayDate(rev.dueDate)}</span>` : "";
  const doneNote = st === "completed" && rev.completedDate ? `<span>done ${formatDisplayDate(rev.completedDate)}</span>` : "";
  return `
    <div class="task-item revision-item ${st === "completed" ? "done" : ""}">
      <div>
        <div class="rev-title">${task ? escapeHtml(task.title) : "(deleted task)"}</div>
        <div class="rev-meta">
          <span>Subject: ${task ? escapeHtml(task.subject) : "—"}</span>
          <span>Revision ${rev.number}</span>
          <span class="rev-badge rev-${st}">${REVISION_STATUS_LABEL[st]}</span>
          ${lateNote}${doneNote}
        </div>
        ${remark ? `<p class="rev-remark">${escapeHtml(remark)}</p>` : ""}
      </div>
      <div class="task-actions">
        ${st === "completed"
          ? `<button class="btn ghost" data-rev-action="undo" data-rev-id="${rid}" type="button">Undo</button>`
          : `<button class="btn primary" data-rev-action="complete" data-rev-id="${rid}" type="button">Complete</button>`}
        <button class="btn secondary" data-rev-action="remark" data-rev-id="${rid}" type="button">${remark ? "Edit Remark" : "Remark"}</button>
        <button class="btn ghost" data-rev-action="history" data-task-id="${escapeHtml(rev.taskId)}" type="button">History</button>
      </div>
    </div>`;
}

function renderRevisionHome(){
  const listEl = $("#revisionTodayList");
  if(!listEl) return;
  const today = todayISO();
  const c = revisionRangeCounts(today, today);   // same function the Statistics chart uses
  $("#revTotalToday").textContent = c.total;
  $("#revPendingToday").textContent = c.pending;
  $("#revCompleteToday").textContent = c.completed;

  const taskMap = new Map(state.tasks.map(t => [t.id, t]));
  const titleOf = (r) => (taskMap.get(r.taskId) || {}).title || "";

  const todays = state.revisions.filter(r => r.dueDate === today)
    .sort((a, b) => ((a.status === "completed") - (b.status === "completed")) || titleOf(a).localeCompare(titleOf(b)) || a.number - b.number);
  const todayHtml = todays.length
    ? todays.map(r => revisionRowHtml(r, taskMap.get(r.taskId), today)).join("")
    : `<p class="empty-note">No revision scheduled for today.</p>`;
  if(todayHtml !== lastRevisionHomeHtml.today){ listEl.innerHTML = todayHtml; lastRevisionHomeHtml.today = todayHtml; }

  const overdue = overdueSummary(today);
  $("#revisionOverdueWrap").hidden = overdue.count === 0;
  $("#revisionOverdueCount").textContent = overdue.count;
  const toggle = $("#revisionOverdueToggle");
  if(toggle){
    toggle.hidden = overdue.count <= OVERDUE_PREVIEW;
    toggle.textContent = revisionShowAllOverdue ? "Show fewer" : `Show all ${overdue.count} overdue`;
  }
  const overdueHtml = overdue.items.map(r => revisionRowHtml(r, taskMap.get(r.taskId), today)).join("");
  if(overdueHtml !== lastRevisionHomeHtml.overdue){ $("#revisionOverdueList").innerHTML = overdueHtml; lastRevisionHomeHtml.overdue = overdueHtml; }
}

/* ---------- Revision History modal ---------- */
function historyRowHtml(rev, today){
  const st = revisionStatusOf(rev, today);
  const rid = escapeHtml(rev.id);
  const remark = (rev.remark || "").trim();
  const actions = [];
  if(st === "completed") actions.push(`<button class="btn ghost" data-rev-action="undo" data-rev-id="${rid}" type="button">Undo</button>`);
  else if(rev.dueDate <= today) actions.push(`<button class="btn primary" data-rev-action="complete" data-rev-id="${rid}" type="button">Complete</button>`);
  actions.push(`<button class="btn secondary" data-rev-action="remark" data-rev-id="${rid}" type="button">${remark ? "Edit Remark" : "Remark"}</button>`);
  return `
    <div class="rev-row rev-row-${st}">
      <span class="rev-mark">${st === "completed" ? "✓" : "○"}</span>
      <div>
        <div><strong>Revision ${rev.number}</strong> — ${formatDisplayDate(rev.dueDate)} <span class="rev-badge rev-${st}">${REVISION_STATUS_LABEL[st]}</span></div>
        ${st === "completed" && rev.completedDate ? `<div class="rev-meta">Completed on ${formatDisplayDate(rev.completedDate)}</div>` : ""}
        ${remark ? `<p class="rev-remark">${escapeHtml(remark)}</p>` : ""}
      </div>
      <div class="rev-row-actions">${actions.join("")}</div>
    </div>`;
}

function renderRevisionHistory(){
  const box = $("#revisionHistoryContent");
  if(!box) return;
  const today = todayISO();
  const openIds = new Set([...box.querySelectorAll("details[open]")].map(d => d.dataset.taskId));
  const wasEmpty = box.children.length === 0;

  const grouped = new Map();
  for(const r of state.revisions){
    if(revisionHistoryTaskId && r.taskId !== revisionHistoryTaskId) continue;
    if(!grouped.has(r.taskId)) grouped.set(r.taskId, []);
    grouped.get(r.taskId).push(r);
  }
  const entries = [...grouped.entries()]
    .map(([taskId, revs]) => ({ task: state.tasks.find(t => t.id === taskId), revs: revs.sort((a, b) => a.number - b.number) }))
    .filter(e => e.task)
    .sort((a, b) => (b.task.revisionAnchor || "").localeCompare(a.task.revisionAnchor || ""));

  $("#revisionHistoryTitle").textContent = revisionHistoryTaskId ? "Revision History" : "All Revision History";

  if(!entries.length){
    box.innerHTML = `<p class="empty-note">No revisions yet. Complete a task and its revision schedule starts automatically.</p>`;
    return;
  }

  box.innerHTML = entries.map(({ task, revs }) => {
    const done = revs.filter(r => r.status === "completed").length;
    const next = revs.find(r => r.status !== "completed");
    const open = revisionHistoryTaskId || entries.length === 1 || openIds.has(task.id) ? "open" : "";
    return `
      <details class="rev-task" data-task-id="${escapeHtml(task.id)}" ${open}>
        <summary>
          <div class="rev-task-name">${escapeHtml(task.title)}</div>
          <div class="rev-task-sub">Subject: ${escapeHtml(task.subject)} · Task Completed: ${formatDisplayDate(task.revisionAnchor || task.completedAt)}</div>
          <div class="rev-task-sub">${done} of ${revs.length} scheduled done · Next: ${next ? formatDisplayDate(next.dueDate) : "—"}</div>
        </summary>
        <div class="rev-rows">${revs.map(r => historyRowHtml(r, today)).join("")}</div>
      </details>`;
  }).join("") + `<p class="rev-note">Schedule: +3 days, then +7 days, then every 14 days after the previous revision — continuing indefinitely.</p>`;
}

function openRevisionHistory(taskId){
  revisionHistoryTaskId = taskId || null;
  $("#revisionHistoryContent").innerHTML = "";
  renderRevisionHistory();
  $("#revisionHistoryModal").hidden = false;
}
function closeRevisionHistory(){ $("#revisionHistoryModal").hidden = true; }
function refreshRevisionHistoryIfOpen(){
  const m = $("#revisionHistoryModal");
  if(m && !m.hidden) renderRevisionHistory();
}

/* ---------- Remark modal ---------- */
let remarkRevisionId = null;
function openRemarkModal(revId){
  const r = state.revisions.find(x => x.id === revId);
  if(!r) return;
  const task = taskForRevision(r);
  remarkRevisionId = revId;
  $("#revisionRemarkTitle").textContent = task ? task.title : "Remark";
  $("#revisionRemarkSub").textContent = `Revision ${r.number} · ${formatDisplayDate(r.dueDate)}`;
  $("#revisionRemarkText").value = r.remark || "";
  $("#revisionRemarkModal").hidden = false;
  $("#revisionRemarkText").focus();
}
function closeRemarkModal(){ $("#revisionRemarkModal").hidden = true; remarkRevisionId = null; }
function saveRemark(){
  const r = state.revisions.find(x => x.id === remarkRevisionId);
  if(r){
    r.remark = $("#revisionRemarkText").value.trim();
    autosave();
    refreshRevisionHistoryIfOpen();
    toast(r.remark ? "Remark saved" : "Remark cleared");
  }
  closeRemarkModal();
}

function handleRevisionClick(e){
  const btn = e.target.closest("[data-rev-action]");
  if(!btn) return;
  const action = btn.dataset.revAction;
  if(action === "history"){ openRevisionHistory(btn.dataset.taskId); return; }
  const id = btn.dataset.revId;
  if(action === "remark"){ openRemarkModal(id); return; }
  if(action === "complete") setRevisionComplete(id, true);
  if(action === "undo") setRevisionComplete(id, false);
  refreshRevisionHistoryIfOpen();
}

/* ---------- Statistics: Revision Overview ---------- */
function getRevisionRange(range){
  const now = new Date();
  const today = todayISO();
  if(range === "week"){
    const start = localDateKey(startOfWeek(now));
    const end = addDaysKey(start, 6);
    return { start, end, label: `This week · ${formatDisplayDate(start)} – ${formatDisplayDate(end)}` };
  }
  if(range === "month"){
    return {
      start: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
      end: localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      label: `This month · ${monthName(now.getFullYear(), now.getMonth())}`
    };
  }
  if(range === "6m"){
    const start = localDateKey(sixMonthStartDate(now));
    return { start, end: today, label: `Last 6 months · ${formatDisplayDate(start)} – ${formatDisplayDate(today)}` };
  }
  if(range === "all"){
    return { start: "0000-01-01", end: today, label: `All time · up to ${formatDisplayDate(today)}` };
  }
  return { start: today, end: today, label: `Today · ${formatDisplayDate(today)}` };
}

// Bar with rounded top corners and a flat base (own helper so the shared roundRect() is left untouched)
function fillTopRoundedBar(ctx, x, y, w, h, r){
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function renderRevisionOverviewChart(){
  const canvas = $("#revisionOverviewChart");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const range = getRevisionRange(revisionChartRange);
  const c = revisionRangeCounts(range.start, range.end);   // same function Home uses
  const rangeLabel = $("#revisionChartRangeLabel");
  if(rangeLabel) rangeLabel.textContent = range.label;
  const legend = $("#revisionOverviewLegend");

  const styles = getComputedStyle(document.body);
  const textColor = styles.getPropertyValue("--text");
  const mutedColor = styles.getPropertyValue("--muted");
  const lineColor = styles.getPropertyValue("--line");

  const bars = [
    { label:"Total",    value:c.total,     color:"rgba(169,156,137,.6)" },
    { label:"Pending",  value:c.pending,   color:"rgba(232,163,61,.85)" },
    { label:"Complete", value:c.completed, color:"#4f9d69" }
  ];

  if(c.total === 0){
    ctx.fillStyle = mutedColor;
    ctx.font = "17px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No revisions scheduled in this period.", w / 2, h / 2);
    ctx.textAlign = "start";
    if(legend) legend.innerHTML = `<p class="empty-note">Complete a task — its revisions appear here automatically.</p>`;
    return;
  }

  const padTop = 44, padBottom = 42, padX = 20;
  const plotH = h - padTop - padBottom;
  const groupW = (w - padX * 2) / bars.length;
  const barW = Math.min(96, groupW * 0.6);
  const baseY = padTop + plotH;
  const max = Math.max(1, c.total);

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, baseY + .5); ctx.lineTo(w - padX, baseY + .5); ctx.stroke();

  bars.forEach((b, i) => {
    const x = padX + i * groupW + (groupW - barW) / 2;
    const barH = (b.value / max) * plotH;
    if(barH > 0){
      ctx.fillStyle = b.color;
      fillTopRoundedBar(ctx, x, baseY - barH, barW, barH, 10);
    }
    ctx.textAlign = "center";
    ctx.fillStyle = textColor;
    ctx.font = "700 27px 'JetBrains Mono', monospace";
    ctx.fillText(String(b.value), x + barW / 2, baseY - barH - 10);
    ctx.fillStyle = mutedColor;
    ctx.font = "600 18px Inter, sans-serif";
    ctx.fillText(b.label, x + barW / 2, h - 13);
  });
  ctx.textAlign = "start";

  if(legend){
    legend.innerHTML = `
      <div class="legend-row"><span class="swatch" style="background:${bars[0].color}"></span>Total Revision · ${c.total}</div>
      <div class="legend-row"><span class="swatch" style="background:${bars[1].color}"></span>Pending Revision · ${c.pending}</div>
      <div class="legend-row"><span class="swatch" style="background:${bars[2].color}"></span>Complete Revision · ${c.completed}</div>
      <div class="legend-row">Completion rate · ${fmtPercent(c.ratio)}</div>`;
  }
}

/* ---------- wiring ---------- */
function bindRevisionEvents(){
  const home = $("#revisionSection");
  if(home) home.addEventListener("click", handleRevisionClick);
  const histBox = $("#revisionHistoryContent");
  if(histBox) histBox.addEventListener("click", handleRevisionClick);

  const overdueToggle = $("#revisionOverdueToggle");
  if(overdueToggle) overdueToggle.onclick = () => { revisionShowAllOverdue = !revisionShowAllOverdue; renderRevisionHome(); };

  const allBtn = $("#revisionHistoryAllBtn");
  if(allBtn) allBtn.onclick = () => openRevisionHistory(null);
  const closeBtn = $("#revisionHistoryCloseBtn");
  if(closeBtn) closeBtn.onclick = closeRevisionHistory;

  $("#revisionRemarkSave").onclick = saveRemark;
  $("#revisionRemarkCancel").onclick = closeRemarkModal;
  document.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    if(!$("#revisionRemarkModal").hidden) closeRemarkModal();
    else if(!$("#revisionHistoryModal").hidden) closeRevisionHistory();
  });

  $$("#revisionRangeToggle button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.range === revisionChartRange);
    btn.addEventListener("click", () => {
      revisionChartRange = btn.dataset.range;
      $$("#revisionRangeToggle button").forEach(b => b.classList.toggle("active", b === btn));
      renderRevisionOverviewChart();
    });
  });

  const goal = $("#dailyGoalHours");
  if(goal) goal.addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if(!(v > 0) || v > 24){
      e.target.value = getDailyGoalHours();
      toast("Enter a daily goal between 0.5 and 24 hours");
      return;
    }
    state.settings.dailyStudyGoalHours = v;
    autosave();
    toast("Daily study goal saved");
  });

  // Roll the "today" views over at midnight even if the app stays open
  revisionLastDay = todayISO();
  setInterval(() => {
    if(todayISO() !== revisionLastDay){ revisionLastDay = todayISO(); renderAll(); }
  }, 30000);
}

function renderAll(){
  if(syncRevisions()) saveState();
  renderClock();
  renderStats();
  renderRevisionHome();
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
  renderWeeklyComparisonChart();
  renderTaskTimingChart();
  renderSubjectBreakdownChart();
  renderRevisionOverviewChart();
}

function switchView(view){
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.remove("view-active"));
  $("#view-" + view).classList.add("view-active");
}

function notify(title, body){
  if("Notification" in window && Notification.permission === "granted"){
    try {
      new Notification(title, { body, icon: "/favicon.ico" });
    } catch(e) {}
  }
}

/* =============================================================================
   📊 DASHBOARD INTERACTIVE DETAILS MODAL LOGIC
============================================================================= */
function openDashboardDetail(type) {
  const modal = $("#dashDetailModal");
  const title = $("#dashDetailTitle");
  const content = $("#dashDetailContent");

  if(!modal || !title || !content) return;

  if (type === "hours") {
    title.textContent = "⏱️ Total Study Sessions (Date-Wise)";
    const sessions = [...state.focusSessions].sort((a,b)=> (b.timestamp||0) - (a.timestamp||0));
    content.innerHTML = sessions.length
      ? renderTable(
          ["Date", "Time", "Duration"],
          sessions.map(s => [
            s.date,
            s.timestamp ? new Date(s.timestamp).toLocaleTimeString(undefined, {hour:"2-digit", minute:"2-digit"}) : "—",
            formatMinutes(s.minutes || 0)
          ])
        )
      : `<p class="empty-note">No study sessions logged yet.</p>`;

  } else if (type === "tasks") {
    title.textContent = "📌 All Tasks List";
    const tasks = [...state.tasks].sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    content.innerHTML = tasks.length
      ? renderTable(
          ["Created Date", "Completed Date", "Title", "Subject", "Status"],
          tasks.map(t => [
            t.createdAt,
            t.completedAt || "—",
            escapeHtml(t.title),
            escapeHtml(t.subject),
            t.done ? "✅ Completed" : "⏳ Pending"
          ])
        )
      : `<p class="empty-note">No tasks created yet.</p>`;

  } else if (type === "sameDay") {
    title.textContent = "✅ Completed Tasks (Event Day)";
    const sameDayTasks = state.tasks.filter(t => t.done && t.completedAt && t.completedAt === t.createdAt)
                                    .sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    content.innerHTML = sameDayTasks.length
      ? renderTable(
          ["Date", "Title", "Subject", "Priority"],
          sameDayTasks.map(t => [
            t.createdAt,
            escapeHtml(t.title),
            escapeHtml(t.subject),
            t.priority
          ])
        )
      : `<p class="empty-note">No same-day completed tasks found.</p>`;

  } else if (type === "pending") {
    title.textContent = "🔄 Completed Pending Tasks";
    const pendingTasks = state.tasks.filter(t => t.done && t.completedAt && t.completedAt > t.createdAt)
                                    .sort((a,b)=> b.completedAt.localeCompare(a.completedAt));
    content.innerHTML = pendingTasks.length
      ? renderTable(
          ["Created Date", "Completed Date", "Title", "Subject"],
          pendingTasks.map(t => [
            t.createdAt,
            t.completedAt,
            escapeHtml(t.title),
            escapeHtml(t.subject)
          ])
        )
      : `<p class="empty-note">No pending completed tasks found.</p>`;
  }

  modal.hidden = false;
}

/* =============================================================================
   💾 INDEXEDDB OFFLINE SOUND CACHE ENGINE
============================================================================= */
const DB_NAME = "SoumenFocusSoundDB";
const STORE_NAME = "sound_blobs";

function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedAudioUrl(id) {
  try {
    const db = await openAudioDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) {
          const blobUrl = URL.createObjectURL(req.result);
          resolve(blobUrl);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function cacheAudioBlob(id, blob) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(blob, id);
  } catch (e) {}
}

/* =============================================================================
   OFFLINE-PROOF MEDIA SESSION & FOCUS SOUND CONTROLS
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

function stopFocusSound(){
  if(activeCustomAudio){
    try{ activeCustomAudio.pause(); activeCustomAudio.currentTime = 0; }catch(e){}
    activeCustomAudio = null;
  }
  focusSoundPlayingKind = null;
}

async function startFocusSound(kind){
  stopFocusSound();

  if(kind === "none") return;

  const customSound = state.customSounds.find(s => s.id === kind || s.title === kind);
  if(customSound && customSound.audioUrl){
    try {
      let finalAudioSrc = customSound.audioUrl;
      
      const cachedBlobUrl = await getCachedAudioUrl(customSound.id);
      if (cachedBlobUrl) {
        finalAudioSrc = cachedBlobUrl;
      }

      activeCustomAudio = new Audio(finalAudioSrc);
      activeCustomAudio.loop = true;
      activeCustomAudio.volume = state.focusSound.volume;

      activeCustomAudio.play().then(() => {
        focusSoundPlayingKind = kind;

        if (!cachedBlobUrl && navigator.onLine) {
          fetch(customSound.audioUrl)
            .then(res => res.blob())
            .then(blob => cacheAudioBlob(customSound.id, blob))
            .catch(() => {});
        }
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
  const shouldPlaySound = state.timer.running && state.timer.phase === "focus" && desiredKind !== "none";

  if(!shouldPlaySound){
    if(activeCustomAudio) {
      try{ activeCustomAudio.pause(); activeCustomAudio.currentTime = 0; }catch(e){}
      activeCustomAudio = null;
    }
    focusSoundPlayingKind = null;
    return;
  }

  if(focusSoundPlayingKind !== desiredKind){
    startFocusSound(desiredKind);
  } else if(activeCustomAudio && activeCustomAudio.paused){
    activeCustomAudio.play().catch(() => {});
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

/* ---------- SYSTEM CLOCK DIFFERENTIAL TIMER ENGINE ---------- */
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
  stopKeepAliveAudio();
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
  } else {
    state.timer.remaining = Math.max(0, Math.round((state.timer.endAt - now) / 1000));
  }
  
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

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((reg) => {}).catch((err) => {});
  }
}

function bindEvents(){
  $$(".nav-item").forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  const cardHours = $("#cardTotalHours");
  const cardTasks = $("#cardTotalTasks");
  const cardSameDay = $("#cardCompletedSameDay");
  const cardPending = $("#cardCompletedPending");
  const dashCloseBtn = $("#dashDetailCloseBtn");

  if(cardHours) cardHours.onclick = () => openDashboardDetail("hours");
  if(cardTasks) cardTasks.onclick = () => openDashboardDetail("tasks");
  if(cardSameDay) cardSameDay.onclick = () => openDashboardDetail("sameDay");
  if(cardPending) cardPending.onclick = () => openDashboardDetail("pending");
  if(dashCloseBtn) dashCloseBtn.onclick = () => { $("#dashDetailModal").hidden = true; };

  const progressChartPrev = $("#progressChartPrev");
  const progressChartNext = $("#progressChartNext");
  if(progressChartPrev) progressChartPrev.onclick = () => {
    progressChartWeekOffset++;
    renderChart();
  };
  if(progressChartNext) progressChartNext.onclick = () => {
    if(progressChartWeekOffset > 0){
      progressChartWeekOffset--;
      renderChart();
    }
  };

  $$("#trendRangeToggle button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.range === String(monthlyTrendRangeDays));
    btn.addEventListener("click", () => {
      const r = btn.dataset.range;
      monthlyTrendRangeDays = r === "all" ? "all" : Number(r);
      $$("#trendRangeToggle button").forEach(b => b.classList.toggle("active", b === btn));
      renderMonthlyTrendChart();
    });
  });

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
        stopKeepAliveAudio();
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
        stopKeepAliveAudio();
      }
      renderTimer();
      autosave();
    };
  }

  $("#taskForm").addEventListener("submit", e => {
    e.preventDefault();
    const id = $("#taskId").value || crypto.randomUUID();
    const title = $("#taskTitle").value.trim();
    const subject = $("#taskSubject").value.trim();
    const priority = $("#taskPriority").value;

    const existing = state.tasks.findIndex(t => t.id === id);
    if(existing >= 0){
      // Editing an existing task: only update the editable fields.
      // done / createdAt / completedAt must NOT be touched here, or every
      // edit would silently reset progress tracking (undone tasks, wrong dates).
      state.tasks[existing] = { ...state.tasks[existing], title, subject, priority };
    } else {
      state.tasks.unshift({ id, title, subject, priority, done: false, createdAt: todayISO(), completedAt: null });
    }
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
    if(action === "toggle"){
      if(!task.done){
        // Completing a task starts its revision schedule from the ACTUAL completion date
        task.done = true;
        task.completedAt = todayISO();
        task.revisionAnchor = task.completedAt;
        syncRevisions(true);
        autosave();
        toast(`Completed · Revision 1 on ${formatDisplayDate(revisionDueDate(task.revisionAnchor, 1))}`);
      }else{
        // Undo: drop the (untouched) schedule; ask first if revision progress would be lost
        const revs = state.revisions.filter(r => r.taskId === id);
        const hasProgress = revs.some(r => r.status === "completed" || (r.remark || "").trim());
        if(hasProgress && !confirm(`Undo completion? This will also delete this task's revision history (${revs.length} revisions).`)) return;
        task.done = false;
        task.completedAt = null;
        delete task.revisionAnchor;
        state.revisions = state.revisions.filter(r => r.taskId !== id);
        autosave();
      }
    }
    if(action === "revisions"){
      openRevisionHistory(id);
    }
    if(action === "delete"){
      const hasRevisions = state.revisions.some(r => r.taskId === id);
      if(hasRevisions && !confirm("Delete this task and all its revision history?")) return;
      state.tasks = state.tasks.filter(t => t.id !== id);
      state.revisions = state.revisions.filter(r => r.taskId !== id);
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

    state.timer.endAt = Date.now() + state.timer.remaining * 1000;
    state.timer.running = true;
    startTimerLoop();
    requestWakeLock();
    if(document.hidden) startKeepAliveAudio();
    updateFocusSoundForTimerState();
    autosave();
  };

  $("#pauseTimer").onclick = () => {
    evaluateTimer(false);
    state.timer.running = false;
    state.timer.endAt = null;
    releaseWakeLock();
    stopKeepAliveAudio();
    updateFocusSoundForTimerState();
    autosave();
  };

  $("#resumeTimer").onclick = () => {
    stopAlarm();
    userPausedSound = false;
    state.timer.endAt = Date.now() + state.timer.remaining * 1000;
    state.timer.running = true;
    startTimerLoop();
    requestWakeLock();
    if(document.hidden) startKeepAliveAudio();
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
    stopKeepAliveAudio();
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
      isClearingData = true;
      localStorage.removeItem(storageKey());
      localStorage.removeItem(settingsKey());
      state.tasks = [];
      state.revisions = [];
      state.focusSessions = [];
      state.calendar = {};
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
      stopKeepAliveAudio(); // back in foreground — release audio focus so other apps aren't ducked
      renderAll();
    } else if(state.timer.running){
      startKeepAliveAudio(); // backgrounded — keep the timer accurate
    }
  });

  window.addEventListener("focus", ()=>{
    evaluateTimer(true);
    stopKeepAliveAudio(); // foreground again — release audio focus
    renderAll();
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
  registerServiceWorker();
  loadState();

  if(!appBootstrapped){
    appBootstrapped = true;
    bindEvents();
    bindRevisionEvents();
    bindIdleDetection();
    setInterval(renderClock, 1000);
    window.addEventListener("beforeunload", saveState);
    window.addEventListener("pagehide", ()=>{
      if(currentStudent){
        updateStudentActivity(currentStudent.uid, {
          status: "offline",
          currentTimer: formatTime(state.timer.remaining)
        });
      }
    });
  }

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

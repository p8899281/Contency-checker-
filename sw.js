/* constancy checker - background worker for accurate timer & notifications */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "UPDATE_TIMER_NOTIFICATION") {
    const { running, timeText, phase } = event.data;
    
    if (running) {
      self.registration.showNotification(`⏱️ ${timeText} (${phase.toUpperCase()})`, {
        body: "Constancy Checker · Timer Running in Background",
        tag: "constancy-focus-timer",
        renotify: false,
        silent: true
      });
    } else {
      self.registration.getNotifications({ tag: "constancy-focus-timer" }).then((notifications) => {
        notifications.forEach((n) => n.close());
      });
    }
  }
});

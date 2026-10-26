// Sets the theme BEFORE the page paints, so a dark-mode user never sees a white flash.
// It is a separate file (not inline in index.html) because the Content-Security-Policy in nginx.conf
// only allows scripts from our own origin. Keep the storage key in sync with src/lib/theme.tsx.
try {
  var t = localStorage.getItem("theme");
  var dark = t === "dark" || ((t === null || t === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {}

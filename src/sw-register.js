// Register before the app module loads. If an old cache ever serves mismatched
// module generations, the app may fail during import; registration must still
// run so the new worker can install and repair that state on the next launch.
if ("serviceWorker" in navigator) {
  const register = () => {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => {
        // Offline support is a bonus; drawing still works without it.
        console.warn("[slate] service worker registration failed:", error?.message || error);
      });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

// Forwards keyboard / mouse events to Beekeeper Studio so app shortcuts keep working
import "@beekeeperstudio/plugin/dist/eventForwarder";
import { createApp } from "vue";
import { log } from "@beekeeperstudio/plugin";
import App from "./App.vue";
import "./style.css";

window.addEventListener("error", (e) => {
  log.error(e.error ?? e.message);
});

window.addEventListener("unhandledrejection", (e) => {
  log.error(e.reason instanceof Error ? e.reason : String(e.reason));
});

createApp(App).mount("#app");

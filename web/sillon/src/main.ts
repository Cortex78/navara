import { startApp } from "./app/app";

const byId = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
};

void startApp(byId("map"), byId("ui"));

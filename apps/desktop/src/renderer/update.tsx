import React from "react";
import ReactDOM from "react-dom/client";
import { initI18n } from "@valuz/shared/i18n";
import type { LocaleCode } from "@valuz/shared/i18n";
import "@valuz/ui";
import { UpdateWindowApp } from "./components/UpdateWindowApp";

const storedLocale = localStorage.getItem("valuz-locale") as
  | LocaleCode
  | null;
// First run follows the OS language (zh* → Chinese, otherwise English);
// an explicit in-app choice (valuz-locale) always wins.
const systemDefaultLocale = (): LocaleCode =>
  (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
initI18n({
  locale: storedLocale ?? systemDefaultLocale(),
  fallbackLocale: "zh-CN",
});

ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
).render(
  <React.StrictMode>
    <UpdateWindowApp />
  </React.StrictMode>,
);

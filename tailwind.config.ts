import type { Config } from "tailwindcss";

/**
 * تم داشبورد تایلندگرد: گرافیت (technical minimal).
 * رنگ‌ها از متغیرهای CSS در app/globals.css می‌آیند (:root برای روشن، .dark برای تیره).
 * در کامپوننت‌ها هرگز کد رنگ مستقیم ننویسید؛ فقط همین توکن‌ها.
 * خط مویی border/input آلفای خود را از گرافیت می‌گیرند (۸٪ و ۱۱٪)؛ سایهٔ نمایشی نداریم.
 * چیدمان راست‌به‌چپ است؛ فقط کلاس‌های منطقی (ms- / me- / ps- / pe- / start- / end-) به کار برود.
 */
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        /* بدنه: ایران‌سنس X (متغیر --font-body از next/font/local در layout) */
        sans: ["var(--font-body)", "Tahoma", "ui-sans-serif", "sans-serif"],
        /* تیترها: پینار (متغیر --font-display) */
        display: ["var(--font-display)", "Tahoma", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        card: "rgb(var(--card) / <alpha-value>)",
        "card-foreground": "rgb(var(--card-foreground) / <alpha-value>)",
        primary: "rgb(var(--primary) / <alpha-value>)",
        "primary-foreground": "rgb(var(--primary-foreground) / <alpha-value>)",
        secondary: "rgb(var(--secondary) / <alpha-value>)",
        "secondary-foreground": "rgb(var(--secondary-foreground) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        "muted-foreground": "rgb(var(--muted-foreground) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-foreground": "rgb(var(--accent-foreground) / <alpha-value>)",
        border: "rgb(var(--border) / 0.08)",
        input: "rgb(var(--input) / 0.11)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        brand: "rgb(var(--brand) / <alpha-value>)",
        "brand-foreground": "rgb(var(--brand-foreground) / <alpha-value>)",
        destructive: "rgb(var(--destructive) / <alpha-value>)",
        "destructive-foreground": "rgb(var(--destructive-foreground) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        "success-foreground": "rgb(var(--success-foreground) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        "warning-foreground": "rgb(var(--warning-foreground) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        "info-foreground": "rgb(var(--info-foreground) / <alpha-value>)",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        sm: "var(--shape-control)",
        md: "var(--radius)",
        lg: "var(--shape-overlay)",
        xl: "var(--shape-surface)",
      },
      boxShadow: {
        control: "var(--depth-control)",
        surface: "var(--depth-surface)",
        overlay: "var(--depth-overlay)",
        sm: "0 0 #0000",
        md: "0 0 #0000",
        lg: "0 0 #0000",
        xl: "0 0 #0000",
      },
    },
  },
  plugins: [],
};

export default config;

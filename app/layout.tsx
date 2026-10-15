import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./interactions.css";

/* فونت نمایشی تیترها: پینار، نسخه FD با ارقام فارسی (وریبل، wght از ۳۰۰ تا ۹۰۰) */
const fontDisplay = localFont({
  src: "../public/fonts/pinar/Pinar-FD-VF[wght-KSHD-DSTY].woff2",
  variable: "--font-display",
  weight: "300 900",
  display: "swap",
});

/* فونت بدنه: ایران‌سنس X (Regular بدنه، Medium تأکید، Bold دکمه و لیبل مهم) */
const fontBody = localFont({
  src: [
    { path: "../public/fonts/iransansx/IRANSansX-Regular.woff2", weight: "400" },
    { path: "../public/fonts/iransansx/IRANSansX-Medium.woff2", weight: "500" },
    { path: "../public/fonts/iransansx/IRANSansX-Bold.woff2", weight: "700" },
  ],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "داشبورد ایجنتیک تایلندگرد",
  description: "مدیریت و پایش تیم‌های هوش مصنوعی تایلندگرد",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FBFAF7" },
    { media: "(prefers-color-scheme: dark)", color: "#18181B" },
  ],
};

/* حالت تیره: انتخاب ذخیره‌شده در localStorage (tg-theme)، وگرنه prefers-color-scheme.
   پیش از رندر اجرا می‌شود تا فلش رنگی دیده نشود؛ با احراز هویت کاری ندارد. */
const themeInitScript = `(function(){try{var t=localStorage.getItem("tg-theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="fa"
      dir="rtl"
      suppressHydrationWarning
      className={`${fontDisplay.variable} ${fontBody.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

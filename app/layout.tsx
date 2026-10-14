import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./interactions.css";

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
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <link
          rel="preconnect"
          href="https://cdn.jsdelivr.net"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

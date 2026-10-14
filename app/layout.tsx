import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "داشبورد ایجنتیک تایلندگرد",
  description: "مدیریت و پایش تیم‌های هوش مصنوعی تایلندگرد",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fa" dir="rtl">
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
      </head>
      <body>{children}</body>
    </html>
  );
}

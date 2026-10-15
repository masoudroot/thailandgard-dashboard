/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // استقرار روی Prisma Compute: خروجی standalone اجباری است
  // (بدون آن دپلوی موفق می‌شود ولی URL خطا می‌دهد).
  output: "standalone",

  // فشرده‌سازی gzip پاسخ‌ها (پیش‌فرض نکست روشن است؛ این‌جا صریح ثبت می‌شود)
  compress: true,

  // حذف هدر X-Powered-By برای سبک‌تر شدن پاسخ‌ها
  poweredByHeader: false,

  experimental: {
    // کوچک‌سازی باندل آیکون‌ها (lucide) برای لود سریع‌تر روی موبایل
    optimizePackageImports: ["lucide-react"],
  },
};

module.exports = nextConfig;

-- استانداردسازی بُعد امبدینگ دانش روی ۱۵۳۶
--
-- زمینه: ستون knowledge_chunks.embedding از نوع vector(3072) بود؛ بازمانده‌ی
-- دوره‌ای که مدل gemini-embedding-001 (۳۰۷۲ بُعدی) مستقیم ذخیره می‌شد.
-- کد (lib/llm.ts و lib/llm-endpoints.ts) اکنون صریحاً بردار ۱۵۳۶ بُعدی
-- می‌خواهد و اعتبارسنجی می‌کند (EXPECTED_EMBEDDING_DIM = 1536)؛ درج
-- بردار ۱۵۳۶ بُعدی در ستون vector(3072) با خطای pgvector می‌مرد:
-- «expected 3072 dimensions, not 1536».
--
-- بردار ۳۰۷۲ بُعدی را نمی‌شود به ۱۵۳۶ cast کرد، پس چانک‌های قدیمی پاک
-- می‌شوند و بعد از این مایگریشن همه‌ی رکوردهای team_knowledge دوباره
-- ایندکس می‌شوند (اسکریپت ری‌ایندکس).

DELETE FROM public.knowledge_chunks;

ALTER TABLE public.knowledge_chunks
  ALTER COLUMN embedding TYPE vector(1536);

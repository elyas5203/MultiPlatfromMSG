---
doc_id: DOC-TASK-0013-IMPLEMENTATION
owner_domain: governance
status: closed
version: 1.0.0
---

# گزارش اجرای TASK-0013

مجری: `antigraviti-15`؛ نسخه تحویلی: `dca96517e9b6045d3f83be32f9dca22c7b4d6f30`.

۱۳ فایل در `apps/core` تغییر کرد؛ همگی در `allowed_paths` قرارداد هستند. Prisma schema و migration موجودیت‌های Tenant، Brand، Staff، Team و عضویت را افزودند؛ Repository دسترسی Brand/Staff/Team را با `tenant_id` محدود می‌کند. راهنمای `.env.example` ترتیب migration و ساخت نشانگر آزمون را اصلاح می‌کند. `git diff --check` پاک بود و مسیر مسدودی تغییر نکرد.

مجری در پوشه مستقل خود روی PostgreSQL 16.6 و پایگاه تازه، `npm ci`، `prisma migrate deploy`، ساخت نشانگر با `psql`، `npm run build` و `npm test` را با کد خروج صفر گزارش کرد؛ نتیجه آزمون‌ها ۳۰ قبول، صفر شکست و صفر skip بود. پایگاه آزمایشی حذف و سرویس متوقف شد. بازبین `npm ci` و `npm run build` را مستقلاً با کد صفر اجرا کرد؛ اجرای PostgreSQL را تکرار نکرد و رأی خود را با اتکا به شواهد فرمان و خروجی مجری داد.

دو تصمیم/کار باز: انتخاب روش احراز هویت (OTP یا گذرواژه) با مالک، و اعمال واقعی RBAC روی Endpointها در مأموریت آینده. RLS فعال نیست؛ جداسازی خواندن داده به استفاده از Repository وابسته است. نصب دو آسیب‌پذیری متوسط وابستگی را گزارش کرد. این مأموریت مجوز عرضه یا داده واقعی نیست.

برای بازگشت کد، merge این مأموریت قابل revert است؛ بازگشت migration روی داده واقعی آزموده نشده است.

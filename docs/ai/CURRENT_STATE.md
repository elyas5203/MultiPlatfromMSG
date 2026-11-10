---
doc_id: DOC-STATE-CURRENT
owner_domain: governance
status: active
version: 1.3.0
last_verified_commit: HEAD
---

# وضعیت جاری پروژه

**مرحله:** توسعه پرسرعت موازی فاز ۱، فاز ۲ و فاز ۳. TASK-0012 تا TASK-0017 همگی با موفقیت کامل پیاده‌سازی، آزموده و در `main` ادغام شدند. ۴ مأموریت موازی جدید (TASK-0018 تا TASK-0021) فعال و به بات‌های مجری تخصیص یافتند.

## وضعیت فعلی

- پروژه قدیمی و مرجع فقط‌خواندنی: `E:/projects/botMoradi`
- ریشه محصول جدید: `E:/projects/MultiPlatformMsg`
- نسخه پشتیبان قابل‌بازگشت فایل‌های قدیمی: `E:/projects/MultiPlatformMsg_legacy_backup_20261109`
- فایل‌های قدیمی با شمارش مسیر/اندازه، SHA-256 فایل‌های اصلی و Commit Git تطبیق داده شدند.
- انتخاب‌های فناوری در `docs/ai/architecture/TECH_STACK.md` ثبت شده‌اند؛ اسکلت NestJS و PostgreSQL، احراز هویت با نام کاربری و رمز، نشست‌های امن، ابزار AES-256-GCM همراه با حلقه کلید و چرخش نسخه‌دار، و ماژول جریانی پردازش و پاکسازی مخاطبان CSV همگی در `main` ادغام شده‌اند.
- نام تجاری نهایی هنوز انتخاب نشده؛ `MultiPlatformMsg` فقط نام داخلی است.
- مخزن تمیز جدید به GitHub در `elyas5203/MultiPlatfromMSG` متصل است.

## کارهای بسته‌شده

- **TASK-0015 (احراز هویت با نام کاربری و رمز، نشست‌ها و بازنشانی رمز):** مجری `antigraviti-elyas`، بازبین `antigraviti-15` (رأی APPROVED). ادغام شد در کامیت `552227a`.
- **TASK-0016 (حلقه کلید و چرخش Secret با AES-256-GCM v2):** مجری `antigraviti-14`. ادغام شد (`306c2e8`).
- **TASK-0017 (ماژول مستقل جریانی خواندن و پاکسازی CSV مخاطبان):** مجری `antigraviti-9`. ادغام شد (`63264c8`).
- **وضعیت آزمون‌ها:** ۸۴ آزمون مستقل واحد و یکپارچه‌ساز بدون خطا، لغو یا skip با موفقیت اجرا می‌شوند.

## مأموریت‌های هم‌زمان جاری (۴ تسک موازی):

| شناسه | عنوان | مجری | شاخه مستقل | حوزه مجاز |
|---|---|---|---|---|
| **TASK-0018** | تزریق و اعتبارسنجی اجباری کانتکست چندسازمانی (Tenant Context & Middleware) | `antigraviti-14` | `task/TASK-0018-tenant-context` | `apps/core/src/tenant/**` |
| **TASK-0019** | گارد کنترل دسترسی مبتنی بر نقش (RBAC Guards & Roles Matrix) | `antigraviti-15` | `task/TASK-0019-rbac-guards` | `apps/core/src/rbac/**` |
| **TASK-0020** | مدل داده، مایگریشن مخاطبان، برچسب‌ها و انصراف (Contacts & Suppression DB) | `antigraviti-elyas` | `task/TASK-0020-contacts-schema` | `apps/core/prisma/**`, `apps/core/src/contacts/**` |
| **TASK-0021** | موتور محاسباتی دفترکل غیرقابل‌تغییر مالی و رزرو اعتبار (Billing Ledger Math Engine) | `antigraviti-9` | `task/TASK-0021-billing-ledger-engine` | `apps/core/src/billing/**` |

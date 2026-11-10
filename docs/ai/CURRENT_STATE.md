---
doc_id: DOC-STATE-CURRENT
owner_domain: governance
status: active
version: 1.5.0
last_verified_commit: HEAD
---

# وضعیت جاری پروژه

**مرحله:** توسعه پرسرعت موازی فاز ۱، فاز ۲ و فاز ۳. TASK-0012 تا TASK-0021 همگی با موفقیت کامل پیاده‌سازی، آزموده و در `main` ادغام شدند. بسته جدید مأموریت‌های موازی (TASK-0022 تا TASK-0025) فعال و آماده تخصیص به بات‌های مجری است.

## وضعیت فعلی

- پروژه قدیمی و مرجع فقط‌خواندنی: `E:/projects/botMoradi`
- ریشه محصول جدید: `E:/projects/MultiPlatformMsg`
- نسخه پشتیبان قابل‌بازگشت فایل‌های قدیمی: `E:/projects/MultiPlatformMsg_legacy_backup_20261109`
- مخزن تمیز به GitHub در `elyas5203/MultiPlatfromMSG` متصل و همگام است.
- مجموع آزمون‌های واحد و منطقی مستقل پروژه به **۱۴۹ آزمون پاس‌شده با صفر شکست و صفر خطا** رسیده است.

## کارهای بسته‌شده (فازهای ۱ تا ۳)

- **TASK-0012 (اسکلت NestJS و تفکیک چندسازمانی در حافظه):** ادغام شد.
- **TASK-0013 (مهاجرت موجودیت‌های سازمانی PostgreSQL):** ادغام شد.
- **TASK-0014 (ابزار رمزنگاری متقارن امن AES-256-GCM):** ادغام شد.
- **TASK-0015 (احراز هویت با نام کاربری و رمز، نشست‌ها و بازنشانی رمز):** مجری `antigraviti-elyas`. ادغام شد (`552227a`).
- **TASK-0016 (حلقه کلید و چرخش Secret با AES-256-GCM v2):** مجری `antigraviti-14`. ادغام شد (`306c2e8`).
- **TASK-0017 (ماژول مستقل جریانی خواندن و پاکسازی CSV مخاطبان):** مجری `antigraviti-9`. ادغام شد (`63264c8`).
- **TASK-0018 (تزریق و اعتبارسنجی اجباری کانتکست چندسازمانی TenantContext و Middleware):** مجری `antigraviti-14`. ادغام شد (`9b4a00e`).
- **TASK-0019 (گارد کنترل دسترسی مبتنی بر نقش RBAC Guards & Roles Matrix):** مجری `antigraviti-15`. ادغام شد (`bdfea7b`).
- **TASK-0020 (مدل داده، مایگریشن مخاطبان، برچسب‌ها و فهرست انصراف):** مجری `antigraviti-elyas`. ادغام شد (`8bcf41d`).
- **TASK-0021 (موتور محاسباتی دفترکل غیرقابل‌تغییر مالی و رزرو اعتبار BigInt):** مجری `antigraviti-9`. ادغام شد (`45771ee`).

## مأموریت‌های هم‌زمان جاری (۴ تسک موازی):

| شناسه | عنوان | مجری | شاخه مستقل | حوزه مجاز |
|---|---|---|---|---|
| **TASK-0022** | کنترلر و اندپوینت‌های مدیریت مخاطبان و برچسب‌ها با RBAC و کانتکست | `antigraviti-14` | `task/TASK-0022-contacts-endpoints` | `apps/core/src/contacts/**`, `apps/core/test/contacts-api.test.ts` |
| **TASK-0023** | سیاست‌های امنیت سطح سطر PostgreSQL (Row-Level Security) | `antigraviti-15` | `task/TASK-0023-postgres-rls` | `apps/core/prisma/migrations/**`, `apps/core/src/tenant/rls.service.ts` |
| **TASK-0024** | مدل داده و مایگریشن پایگاه داده دفترکل مالی در PostgreSQL | `antigraviti-elyas` | `task/TASK-0024-billing-ledger-schema` | `apps/core/prisma/**`, `apps/core/src/billing/**` |
| **TASK-0025** | پایپلاین یکپارچه واردسازی گروهی مخاطبان از CSV به دیتابیس با انصراف | `antigraviti-9` | `task/TASK-0025-contacts-csv-pipeline` | `apps/core/src/contacts-import/**` |

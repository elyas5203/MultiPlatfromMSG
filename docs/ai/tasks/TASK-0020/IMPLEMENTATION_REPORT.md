# گزارش اجرای مأموریت TASK-0020: مدل داده، مایگریشن و مخزن مخاطبان، برچسب‌ها و فهرست انصراف

- **شناسه مأموریت:** TASK-0020
- **مجری:** `antigraviti-elyas`
- **وضعیت:** COMPLETED
- **شاخه کاری:** `task/TASK-0020-contacts-schema`
- **شناسه کامیت ادغام‌شده:** `8bcf41d` (ادغام در `main`)

## ۱. انطباق با معیارهای پذیرش (Acceptance Criteria)

- **AC-01 (مدل‌های داده و مهاجرت PostgreSQL):**
  - مدل‌های `Contact`, `Tag`, `ContactTag`, `SuppressionEntry` با فیلد اجباری `tenant_id` به `schema.prisma` اضافه شدند.
  - مایگریشن رسمی `20261110160000_contacts_tags_suppression` ایجاد شد.
  - کلیدهای خارجی ترکیبی و حذف آبشاری روی جداول اتصال اعمال شد.
- **AC-02 (قیدهای یکتایی مرکب چندسازمانی):**
  - قید یکتایی مرکب `@@unique([tenantId, phoneNormalized])` روی `Contact` و `SuppressionEntry` اعمال شد.
  - امکان نگهداری مستقل شماره یکسان در سازمان‌های مجزا بدون تداخل اثبات شد.
- **AC-03 (مخزن داده با تفکیک اجباری سازمان ContactsRepository):**
  - اعتبارسنجی قطعی `assertValidTenantId` در سرآغاز تمام متدها.
  - ایزولاسیون کامل عملیات بین سازمان‌ها و مدیریت خودکار پرچم `isSuppressed`.

## ۲. نتایج آزمون‌ها و اعتبارسنجی

- کامپایل تایپ‌اسکریپت: `npm run build` با خروج ۰.
- Prisma Generate & Validate: خروج ۰.
- آزمون‌های دیتابیس PostgreSQL: ۳۹ آزمون موفق در `dist/test/contacts-db.test.js` با خروج ۰ (Pass: 39, Fail: 0).
- کنترل Git: `git diff --check` کاملاً تمیز و رعایت دقیق محدوده `apps/core/prisma/**` و `apps/core/src/contacts/**`.

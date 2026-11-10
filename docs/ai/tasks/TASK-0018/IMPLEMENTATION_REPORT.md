# گزارش اجرای مأموریت TASK-0018: تزریق و اعتبارسنجی اجباری کانتکست چندسازمانی

- **شناسه مأموریت:** TASK-0018
- **مجری:** `antigraviti-14`
- **وضعیت:** COMPLETED
- **شاخه کاری:** `task/TASK-0018-tenant-context`
- **شناسه کامیت ادغام‌شده:** `9b4a00e` (ادغام در `main`)

## ۱. انطباق با معیارهای پذیرش (Acceptance Criteria)

- **AC-01 (کلاس `TenantContext` با AsyncLocalStorage):**
  - پیاده‌سازی متدهای `runWithTenant`، `getTenantId`، `getOptionalTenantId` و `hasContext`.
  - رفتار قطعی Fail-Closed با پرتاب `TenantContextMissingError` در فراخوانی خارج از کانتکست.
  - اعتبارسنجی فرمت شناسه با الگوی `/^[a-zA-Z0-9_-]{1,64}$/`.
  - ایزولاسیون کامل در درخواست‌های همزمان و ناهمگام.
- **AC-02 (میان‌افزار `TenantMiddleware` و اعتبارسنجی هدر):**
  - استخراج و اعتبارسنجی هدر `x-tenant-id`، رد درخواست‌های دارای هدر تکراری (ضد HTTP Smuggling)، حذف فاصله‌های اضافی (trim).
  - رد مقادیر خالی، طولانی‌تر از ۶۴ کاراکتر و کاراکترهای مخرب تزریقی.
- **AC-03 (`TenantGuard` و `TenantInterceptor` با رویکرد Fail-Closed):**
  - عبور مسیرهای عمومی دارای دکوراتور `@Public()`.
  - مسدودسازی قطعی مسیرهای محافظت‌شده با خطای `BadRequestException` (HTTP 400) در غیاب یا نامعتبر بودن `tenant_id`.

## ۲. نتایج آزمون‌ها و اعتبارسنجی

- کامپایل تایپ‌اسکریپت: `npm run build` با خروج ۰.
- اجرای تست‌های واحد و همزمانی: ۲۰ آزمون موفق در `dist/test/tenant-context.test.js` با خروج ۰ (Pass: 20, Fail: 0).
- کنترل Git: `git diff --check` کاملاً تمیز و رعایت دقیق محدوده `apps/core/src/tenant/**`.

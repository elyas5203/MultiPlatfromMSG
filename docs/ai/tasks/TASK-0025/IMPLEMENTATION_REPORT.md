# گزارش اجرای مأموریت TASK-0025: پایپلاین یکپارچه واردسازی گروهی مخاطبان از CSV به دیتابیس با انصراف و گزارش

- **شناسه مأموریت:** TASK-0025
- **مجری:** `antigraviti-9`
- **وضعیت:** COMPLETED
- **شاخه کاری:** `task/TASK-0025-contacts-csv-pipeline`
- **شناسه کامیت ادغام‌شده:** `ec5631b` (ادغام در `main`)

## ۱. انطباق با معیارهای پذیرش (Acceptance Criteria)

- **AC-01 (واردسازی جریانی، دسته‌بندی و تزریق اجباری سازمان):**
  - پیاده‌سازی متد `importStreamIntoRepository` در کلاس `ContactsCsvPipelineService`.
  - اعتبارسنجی سخت‌گیرانه `tenant_id` و پرتاب خطاهای `TenantScopeMissingError` و `TenantScopeInvalidError`.
  - درج در دسته‌های قابل تنظیم (پیش‌فرض ۵۰۰ تایی) با فراخوانی کال‌بک پیشرفت `onBatchProgress`.
  - پردازش جریانی بدون بار اضافی روی حافظه (آزمون پردازش ۲۰۰۰ ردیف در ۱۰۲ میلی‌ثانیه).
- **AC-02 (پشتیبانی از فهرست انصراف و ایزولاسیون سازمانی):**
  - بررسی بلادرنگ شماره‌ها در جدول `suppression_entries`.
  - پشتیبانی از سیاست‌های `SKIP` (عدم درج شماره مسدود) و `IMPORT_AS_SUPPRESSED` (درج با پرچم مسدودی).
  - تفکیک قطعی لیست انصراف به ازای هر سازمان.
- **AC-03 (گزارش ساختاریافته و تضمین حریم خصوصی):**
  - ارائه گزارش با فیلدهای `totalRows, processedRows, importedCount, duplicatesSkippedCount, suppressedCount, invalidCount, errorsCount`.
  - تضمین عدم افشای شماره‌های خام در لاگ‌ها و گزارش‌ها (Zero Phone Leakage / Masking).
  - انتساب خودکار برچسب پیش‌فرض سازمان به مخاطبان جدید.

## ۲. نتایج آزمون‌ها و اعتبارسنجی

- کامپایل تایپ‌اسکریپت: `npm run build` با خروج ۰.
- اجرای تست‌های واحد و جریانی: ۱۳ آزمون جامع در ۴ سوئیت در `dist/test/contacts-csv-pipeline.test.js` با خروج ۰ (Pass: 13, Fail: 0).
- کنترل Git: `git diff --check` کاملاً تمیز و رعایت دقیق محدوده `apps/core/src/contacts-import/**`.

---
doc_id: DOC-TASK-0016-IMPLEMENTATION
owner_domain: governance
status: closed
version: 1.0.0
---

# گزارش اجرای TASK-0016 (حلقه کلید و چرخش نسخه ۲ Secret با AES-256-GCM)

مأموریت TASK-0016 توسط `antigraviti-14` روی شاخه `task/TASK-0016-key-ring` با کامیت `30b31ce97a897f3be35216831b8442bfe6868cf5` پیاده‌سازی شد و پس از بررسی و تطبیق آزمون‌های واحد، در شاخه `main` ادغام شد.

## ۱. مشخصات پیاده‌سازی و انطباق با قرارداد
- **تعداد فایل‌های تغییریافته:** ۳ فایل (در سقف مجاز ۳ فایل):
  1. `apps/core/src/security/key-ring.ts`: پیاده‌سازی کلاس `KeyRing`، پارسر fail-closed، اتصال `keyId` به AAD، و بازرمزگذاری (`reencrypt`).
  2. `apps/core/src/security/secret-crypto.ts`: افزودن `encryptSecretV2` و `decryptSecretV2` با حفظ سازگاری کامل با پاکت‌های `v1`.
  3. `apps/core/test/key-ring.test.ts`: ۲۲ آزمون جامع برای پوشش AC-01 تا AC-04.
- **وابستگی جدید:** صفر وابستگی.
- **تغییرات دیتابیس یا Schema:** صفر.

## ۲. پوشش معیارهای پذیرش
- **AC-01:** بارگذاری پیکربندی با سیاست fail-closed؛ کلیدهای کوتاه‌تر/بلندتر از ۳۲ بایت یا شناسه‌های غیرمجاز رد می‌شوند.
- **AC-02:** قالب پاکت نسخه‌دار `v2.<keyId>.<nonce hex>.<tag hex>.<ciphertext hex>`، احراز اصالت با اتصال `keyId` به AAD، و پشتیبانی از رمزگشایی پاکت‌های `v1`.
- **AC-03:** متد `reencrypt` با کلید فعال جدید و نانس تازه مقادیر قبلی را بازرمز می‌کند.
- **AC-04:** عدم افشای کلید در لاگ یا خطاها و کلون‌کردن بافرهای کلید در حافظه.

## ۳. شواهد آزمون
- ۲۸ آزمون واحد در `dist/test/key-ring.test.js` و `dist/test/secret-crypto.test.js` با کد خروج صفر اجرا و تأیید شدند.

## ۴. وضعیت مأموریت
وضعیت: **CLOSED**. ادغام در `main` انجام شد.

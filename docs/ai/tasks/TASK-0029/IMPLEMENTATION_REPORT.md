# گزارش اجرای مأموریت TASK-0029: الگوریتم مسیریابی و انتخاب خودکار حساب فرستنده

**شناسه مأموریت:** TASK-0029  
**فاز:** فاز ۴ ج — زیرساخت فرستنده‌ها و مسیریابی  
**مجری:** `antigraviti-9`  
**وضعیت:** تکمیل، اعتبارسنجی و ادغام در `main` (`88d4e6b`)  
**تعداد آزمون‌ها:** ۲۱/۲۱ آزمون موفق (Pass: 21, Fail: 0)  

---

## ۱. انطباق با معیارهای پذیرش (Acceptance Criteria)

- **AC-01 (الگوریتم رتبه‌بندی و انتخاب بهینه فرستنده):**
  - اولویت قطعی با اکانت‌های دارای ارتباط متقابل (`isMutualContact`).
  - توزیع بار هوشمند بر مبنای سهمیه روزانه باقیمانده (`dailyQuotaRemaining`) در صورت تساوی شرایط ارتباط متقابل.
  - تعادل بار در صورت تساوی سهمیه، از طریق انتخاب اکانت با کمترین بار کاری فعال (`activeWorkload`).
  - پشتیبانی از اولویت‌بندی کانال‌های اختصاصی یا اشتراکی و فیلتر برچسب‌های اجباری (`requiredTags`).

- **AC-02 (پایش دقیق سلامت اکانت، FloodWait و سهمیه روزانه):**
  - حذف قطعی اکانت‌های `BANNED` و `DISABLED`.
  - مدیریت دوره تنفس خودکار (`COOLDOWN`) در هنگام وقوع خطای محدودیت زمانی پلتفرم نظیر تلگرام FloodWait تا زمان انقضای موعد.
  - خروج بلادرنگ اکانت‌های با سهمیه روزانه به پایان رسیده و پشتیبانی از ثبت ارسال (`recordDispatch`)، پایان ارسال (`completeDispatch`) و ریست سهمیه روزانه.

- **AC-03 (ایزولاسیون کامل چندسازمانی Fail-Closed):**
  - عدم تداخل اکانت‌ها یا مخاطبان متقابل میان سازمان‌ها تحت هیچ شرایطی.
  - پرتاب خطاهای صریح `TenantScopeMissingError` و `TenantScopeInvalidError` در صورت فقدان یا نامعتبر بودن شناسه سازمان.

---

## ۲. خلاصه فایل‌های تحویلی

- [`apps/core/src/senders/types.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/senders/types.ts): تعاریف وضعیت سلامت، کانفیگ اکانت فرستنده و اینترفیس‌های مسیریابی.
- [`apps/core/src/senders/routing-engine.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/senders/routing-engine.ts): کلاس `SenderRoutingEngine` متصل به استانداردهای NestJS.
- [`apps/core/src/senders/index.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/senders/index.ts): صادرات تمیز ماژول.
- [`apps/core/test/sender-routing.test.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/test/sender-routing.test.ts): مجموعه ۲۱ آزمون واحد و چندسازمانی جامع.

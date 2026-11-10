# گزارش اتمام مأموریت TASK-0028: هسته توقف اضطراری (Kill Switch Core) و صفوف پیام

**شناسه مأموریت:** TASK-0028  
**فاز:** فاز ۵.ب - سوییچ توقف اضطراری و صفوف پیام  
**مجری:** `antigraviti-9`  
**وضعیت:** تأییدشده، تست‌شده و ادغام در `main` (کامیت ادغام‌شده `af787ce`)  
**آمار آزمون‌ها:** ۱۷/۱۷ آزمون پاس (Pass: 17, Fail: 0)  

---

## ۱. انطباق با معیارهای پذیرش (Acceptance Criteria)

- **رفتار ۱ (مسدودسازی پذیرش‌های جدید - Block New Admissions):**
  - متد `canAdmit(tenantId, channel?)` با استراتژی Fail-Closed در صورت فعال بودن کلید سراسری، سازمانی یا کانالی، اجازه ورود پیام جدید نمی‌دهد.
  - متد `assertCanAdmit` در صورت فعال بودن سوییچ، خطای استاندارد `KillSwitchActiveError` پرتاب می‌کند.
  - اعمال ایزولاسیون کامل سازمانی: سوییچ فعال برای یک سازمان بر سایر مستأجران اثری ندارد.
  - در حالت لغو سوییچ (`deactivate`)، مسیر پذیرش‌ها به حالت عادی بازمی‌گردد.

- **رفتار ۲ (مدیریت وظایف در جریان - In-Flight Tasks Safety):**
  - ثبت وظایف در حال پردازش همراه با `AbortController` مجزا.
  - در صورت فراخوانی `abortInFlightTasks` یا فعال‌سازی سوییچ با فلگ `abortInFlightImmediately: true`، سیگنال abort به کنترلر وظایف ارسال شده و وظایف سقط می‌شوند.
  - وضعیت خروجی وظایف با خطای `InFlightTaskAbortedError` مشخص می‌شود.

- **رفتار ۳ (تعلیق مصرف‌کننده‌های صفوف معلق - Suspend Pending Queue Consumers):**
  - متدهای `suspendConsumerQueue` و `resumeConsumerQueue` برای تعلیق مصرف‌کننده‌های صفوف خروجی RabbitMQ بدون حذف فیزیکی یا مفقود شدن پیام‌های صف.
  - در صورت فعال‌سازی کلید سراسری، تمام صفوف خودکار در وضعیت `suspended` قرار می‌گیرند.

- **قراردادها و توپولوژی صفوف RabbitMQ:**
  - ساختار صفی استاندارد شامل `msg.direct`، `msg.dispatch.outbound`، `msg.dead-letter` و کلید `msg.control.kill`.

---

## ۲. فایل‌های تغییریافته و ایجادشده

- [`apps/core/src/messaging/queue.types.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/messaging/queue.types.ts): تعاریف تایپ‌ها، پاکت صف و توپولوژی.
- [`apps/core/src/messaging/kill-switch.service.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/messaging/kill-switch.service.ts): پیاده‌سازی کامل سرویس سوییچ اضطراری با رخدادنگاری و جداسازی کانتکست.
- [`apps/core/src/messaging/index.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/src/messaging/index.ts): اکسپورت تمیز ماژول.
- [`apps/core/test/kill-switch.test.ts`](file:///E:/projects/MultiPlatformMsg/apps/core/test/kill-switch.test.ts): ۱۷ آزمون مستقل و جامع.

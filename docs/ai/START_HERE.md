---
doc_id: DOC-GOV-START
owner_domain: governance
status: active
version: 2.0.0
last_verified_commit: pending-first-commit
---

# نقطه شروع اجباری تمام هوش‌های مصنوعی

این فایل تنها ورودی ثابت پروژه است. هیچ AI نباید کار را با خواندن تصادفی کل مخزن شروع کند.

## ترتیب شروع

1. نقش خود را از مأموریت جاری مشخص کن: `manager`، `coder` یا `reviewer`.
2. `docs/ai/CURRENT_STATE.md` را بخوان.
3. قوانین نقش خود را از `docs/ai/governance/` بخوان.
4. فقط `TASK_CONTRACT.yaml` مأموریت فعال و فایل‌های `must_read` آن را بخوان.
5. اگر مأموریت وضعیت `APPROVED` ندارد، هیچ فایلی را تغییر نده.
6. اگر پاسخ یک تصمیم تجاری در اسناد موجود نیست، آن را حدس نزن.

## مسیرهای اصلی

- نقشه اسناد: `docs/ai/DOCUMENT_MAP.yaml`
- وضعیت جاری: `docs/ai/CURRENT_STATE.md`
- قوانین مدیر: `docs/ai/governance/MANAGER_PROTOCOL.md`
- قوانین کدنویس: `docs/ai/governance/CODER_PROTOCOL.md`
- قوانین بازبین: `docs/ai/governance/REVIEWER_PROTOCOL.md`
- نبایدهای مطلق: `docs/ai/governance/ABSOLUTE_PROHIBITIONS.md`
- چرخه اجباری هر کار: `docs/ai/governance/TASK_LIFECYCLE.md`
- مدل همکاری تیم هوش مصنوعی: `docs/ai/governance/AI_TEAM_OPERATING_MODEL.md`
- محدوده نسخه اول: `docs/ai/product/VERSION_ONE_SCOPE.md`
- معماری کلان: `docs/ai/architecture/SYSTEM_CONTEXT.md`

## قانون توقف

در هر یک از شرایط زیر فوراً متوقف شو و گزارش `BLOCKED` بده:

- نیاز به فایل خارج از محدوده مأموریت؛
- ابهام در رفتار محصول؛
- نیاز به تغییر دیتابیس، قرارداد عمومی، وابستگی یا Secret بدون مجوز؛
- مشاهده تغییرات هم‌زمان یا ناشناخته در فایل هدف؛
- ناتوانی در اجرای تست اجباری؛
- احتمال افشای اطلاعات یک سازمان به سازمان دیگر؛
- احتمال ارسال تکراری، هزینه تکراری یا اقدام مخرب.

## قانون فایل مأموریت

کدنویسی فقط وقتی مجاز است که پوشه‌ای به شکل `docs/ai/tasks/TASK-XXXX/` وجود داشته باشد و فایل `TASK_CONTRACT.yaml` آن با وضعیت `APPROVED_FOR_IMPLEMENTATION` ثبت شده باشد. پیام چت، توضیح شفاهی یا درخواست کلی جای قرارداد مأموریت را نمی‌گیرد.


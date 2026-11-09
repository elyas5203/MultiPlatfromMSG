---
doc_id: DOC-GOV-MAUSBOT-SETUP
owner_domain: governance
status: active
version: 1.0.0
---

# چک‌لیست راه‌اندازی تیم در MausBot

## پوشه‌های آماده

| Bot | Working Folder |
|---|---|
| Chief با Claude Code | `E:\projects\MultiPlatformMsg` |
| `antigraviti-14` | `E:\projects\MultiPlatformMsg-agents\antigravity-14` |
| `antigraviti-15` | `E:\projects\MultiPlatformMsg-agents\antigravity-15` |
| `antigraviti-elyas` | `E:\projects\MultiPlatformMsg-agents\antigravity-elyas` |
| `antigraviti-9` | `E:\projects\MultiPlatformMsg-agents\antigravity-9` |
| `chatgpt` برای بازبینی | `E:\projects\MultiPlatformMsg-agents\chatgpt-reviewer` |

تمام پوشه‌ها از یک نسخه Git یکسان ساخته شده و به Repository مشترک متصل‌اند.

## تنظیم Chief

- Engine: Claude Code، نه Chat engine ساده؛
- Model: مدل توانمند Claude موجود در اشتراک؛
- Role: Chief of Staff؛
- Working Folder: ریشه محصول؛
- Approval: حالت عادی/Ask، نه Full Access عمومی؛
- دسترسی به هم‌تیمی‌ها: فعال؛
- دستور ثابت: شروع از `docs/ai/START_HERE.md` و اجرای `MANAGER_BOOTSTRAP.md`؛
- Backup Model برای کار مدیریتی قابل استفاده است، ولی کار نامطمئن خودکار تکرار نشود.

## تنظیم Workerها

- هر Bot فقط حساب مستقل خودش را استفاده کند.
- Working Folder مطابق جدول بالا باشد.
- شروع هر کار فقط از قرارداد مأموریت تأییدشده باشد.
- کار مستقیم روی `main` ممنوع باشد.
- Full Access عمومی خاموش باشد.
- Bot حق تغییر اسناد مادر یا فایل خارج از قرارداد را نداشته باشد.

## تنظیم Reviewer

- Working Folder جدا مطابق جدول؛
- فقط خواندن Diff، اجرای تست غیرمخرب و نوشتن Review Report؛
- اصلاح مستقیم کد ممنوع؛
- بازبینی کار خودش ممنوع.

## آزمون راه‌اندازی

Chief باید بدون کدنویسی این موارد را گزارش کند:

1. نام و موتور هر Bot؛
2. Working Folder هر Bot؛
3. مستقل‌بودن حساب‌ها؛
4. دسترسی به `START_HERE.md`؛
5. نبود دو Bot نویسنده در یک پوشه؛
6. وضعیت اتصال GitHub؛
7. مغایرت‌های تنظیمات؛
8. تأیید اینکه مرحله پروژه هنوز تحلیل است.

تا قبل از موفقیت این آزمون، کدنویسی محصول ممنوع است.
